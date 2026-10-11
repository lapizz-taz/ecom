<?php
/**
 * Orders:
 *
 * - A new order and every status change are queued for Fullfilio at once (the
 *   outbox retries until Fullfilio has them). Fullfilio then reads the order
 *   through the WooCommerce REST API, so it always takes WooCommerce's own
 *   copy; WooCommerce webhooks keep running as a second path. Both carry the
 *   same order id, and Fullfilio imports an order only once.
 * - Fullfilio sets the order's status here as the order moves on there:
 *   Confirmed, Shipped, Delivered, Partially delivered, Return in transit,
 *   Returned, Cancelled. WooCommerce has no such statuses, so this plugin adds
 *   them. A status Fullfilio sets is not sent back to it.
 * - Stock that comes back (a return, the undelivered part of a partial
 *   delivery) is handled by FFC_Stock.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Orders {
	/** True while Fullfilio's own status is being written, so it is not sent back. */
	private static $applying = false;

	public static function statuses() {
		return array(
			'wc-confirmed'         => _x( 'Confirmed', 'Order status', 'fullfilio-connect' ),
			'wc-shipped'           => _x( 'Shipped', 'Order status', 'fullfilio-connect' ),
			'wc-delivered'         => _x( 'Delivered', 'Order status', 'fullfilio-connect' ),
			'wc-partial-delivered' => _x( 'Partially delivered', 'Order status', 'fullfilio-connect' ),
			'wc-returning'         => _x( 'Return in transit', 'Order status', 'fullfilio-connect' ),
			'wc-returned'          => _x( 'Returned', 'Order status', 'fullfilio-connect' ),
		);
	}

	/** Statuses Fullfilio may set: ours plus WooCommerce's own. */
	public static function settable() {
		return array_merge( array( 'processing', 'on-hold', 'completed', 'cancelled' ), array_map( static function ( $k ) {
			return substr( $k, 3 );
		}, array_keys( self::statuses() ) ) );
	}

	public static function init() {
		add_action( 'woocommerce_new_order', array( __CLASS__, 'created' ), 20, 2 );
		add_action( 'woocommerce_order_status_changed', array( __CLASS__, 'status_changed' ), 20, 4 );
		if ( FFC_Settings::config()['custom_statuses'] ) {
			add_action( 'init', array( __CLASS__, 'register_statuses' ) );
			add_filter( 'wc_order_statuses', array( __CLASS__, 'add_statuses' ) );
			add_filter( 'woocommerce_reports_order_statuses', array( __CLASS__, 'report_statuses' ) );
			add_filter( 'woocommerce_order_is_paid_statuses', array( __CLASS__, 'paid_statuses' ) );
		}
	}

	public static function register_statuses() {
		foreach ( self::statuses() as $slug => $label ) {
			register_post_status(
				$slug,
				array(
					'label'                     => $label,
					'public'                    => false,
					'exclude_from_search'       => false,
					'show_in_admin_all_list'    => true,
					'show_in_admin_status_list' => true,
					/* translators: %s: number of orders */
					'label_count'               => _n_noop( $label . ' <span class="count">(%s)</span>', $label . ' <span class="count">(%s)</span>', 'fullfilio-connect' ), // phpcs:ignore WordPress.WP.I18n.NonSingularStringLiteralSingular,WordPress.WP.I18n.NonSingularStringLiteralPlural
				)
			);
		}
	}

	/** Confirmed and Shipped after Processing, the rest after Completed. */
	public static function add_statuses( $statuses ) {
		$ours  = self::statuses();
		$early = array_intersect_key( $ours, array_flip( array( 'wc-confirmed', 'wc-shipped' ) ) );
		$late  = array_diff_key( $ours, $early );
		$out   = array();
		foreach ( $statuses as $key => $label ) {
			$out[ $key ] = $label;
			if ( 'wc-processing' === $key ) {
				$out = array_merge( $out, $early );
			}
			if ( 'wc-completed' === $key ) {
				$out = array_merge( $out, $late );
			}
		}
		return array_merge( $out, $ours );
	}

	/** Orders on their way or delivered count as sales in WooCommerce's own reports. */
	public static function report_statuses( $statuses ) {
		if ( is_array( $statuses ) && in_array( 'completed', $statuses, true ) ) {
			$statuses = array_merge( $statuses, array( 'confirmed', 'shipped', 'delivered', 'partial-delivered' ) );
		}
		return array_values( array_unique( (array) $statuses ) );
	}

	public static function paid_statuses( $statuses ) {
		return array_values( array_unique( array_merge( (array) $statuses, array( 'delivered', 'partial-delivered' ) ) ) );
	}

	public static function created( $order_id, $order = null ) {
		if ( ! FFC_Settings::enabled( 'order_events' ) ) {
			return;
		}
		$order = $order instanceof WC_Order ? $order : wc_get_order( $order_id );
		if ( ! $order || 'shop_order_refund' === $order->get_type() ) {
			return;
		}
		FFC_Outbox::push( 'order', array( 'order_id' => (int) $order_id, 'event' => 'created', 'status' => $order->get_status(), 'number' => $order->get_order_number() ) );
	}

	public static function status_changed( $order_id, $from, $to, $order = null ) {
		if ( self::$applying || ! FFC_Settings::enabled( 'order_events' ) || $from === $to ) {
			return;
		}
		FFC_Outbox::push( 'order', array( 'order_id' => (int) $order_id, 'event' => 'status', 'from' => $from, 'status' => $to ) );
	}

	/**
	 * Fullfilio's update for one order: its status here, and the items that came
	 * back to put in stock (cumulative per line; see FFC_Stock::restock()).
	 *
	 * @param array $input order_id, status, note?, restock?, stock_sync?
	 * @return array|WP_Error
	 */
	public static function apply_from_fullfilio( $input ) {
		$order_id = isset( $input['order_id'] ) ? absint( $input['order_id'] ) : 0;
		$status   = isset( $input['status'] ) ? sanitize_key( (string) $input['status'] ) : '';
		$order    = $order_id ? wc_get_order( $order_id ) : false;
		if ( ! $order || 'shop_order_refund' === $order->get_type() ) {
			return new WP_Error( 'ffc_no_order', 'Order not found.', array( 'status' => 404 ) );
		}
		if ( ! in_array( $status, self::settable(), true ) || ! array_key_exists( 'wc-' . $status, wc_get_order_statuses() ) ) {
			return new WP_Error( 'ffc_status', sprintf( 'Unknown order status "%s". Turn on "Order statuses" in Fullfilio.', $status ), array( 'status' => 422 ) );
		}
		if ( isset( $input['stock_sync'] ) ) {
			FFC_Settings::save_config( array( 'stock_sync' => (bool) $input['stock_sync'] ) );
		}

		$from    = $order->get_status();
		$changed = false;
		if ( $from !== $status ) {
			// A cancelled, refunded or failed order is not brought back by an update.
			if ( in_array( $from, array( 'cancelled', 'refunded', 'failed', 'trash' ), true ) && 'cancelled' !== $status ) {
				return new WP_Error( 'ffc_final', sprintf( 'The order is %s in WooCommerce, so it was not changed to %s.', $from, $status ), array( 'status' => 409 ) );
			}
			$note = isset( $input['note'] ) ? sanitize_text_field( (string) $input['note'] ) : '';
			$app  = FFC_Settings::connection();
			$who  = $app ? $app['app_name'] : 'Fullfilio';
			self::$applying = true;
			try {
				$order->update_status( $status, trim( sprintf( '%s: %s', $who, $note ? $note : wc_get_order_status_name( $status ) ) ) );
			} finally {
				self::$applying = false;
			}
			$changed = true;
		}

		$restocked = array();
		if ( ! empty( $input['restock'] ) && is_array( $input['restock'] ) ) {
			$restocked = FFC_Stock::restock( wc_get_order( $order_id ), $input['restock'], 'returned' === $status ? 'return' : 'partial delivery' );
		}
		return array(
			'ok'        => true,
			'status'    => wc_get_order( $order_id )->get_status(),
			'from'      => $from,
			'changed'   => $changed,
			'restocked' => $restocked,
		);
	}
}
