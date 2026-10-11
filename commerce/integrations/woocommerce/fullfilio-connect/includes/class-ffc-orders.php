<?php
/**
 * Orders:
 *
 * - A new order and every status change are queued for Fullfilio at once (the
 *   outbox retries until Fullfilio has them). Fullfilio then reads the order
 *   through the WooCommerce REST API, so it always takes WooCommerce's own
 *   copy; WooCommerce webhooks keep running as a second path. Both carry the
 *   same order id, and Fullfilio imports an order only once.
 * - Two statuses courier work needs and WooCommerce lacks: Delivered and
 *   Returned. Fullfilio sets them when the courier reports it.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Orders {
	public static function statuses() {
		return array(
			'wc-delivered' => _x( 'Delivered', 'Order status', 'fullfilio-connect' ),
			'wc-returned'  => _x( 'Returned', 'Order status', 'fullfilio-connect' ),
		);
	}

	public static function init() {
		add_action( 'woocommerce_new_order', array( __CLASS__, 'created' ), 20, 2 );
		add_action( 'woocommerce_order_status_changed', array( __CLASS__, 'status_changed' ), 20, 4 );
		if ( FFC_Settings::config()['custom_statuses'] ) {
			add_action( 'init', array( __CLASS__, 'register_statuses' ) );
			add_filter( 'wc_order_statuses', array( __CLASS__, 'add_statuses' ) );
			add_filter( 'woocommerce_reports_order_statuses', array( __CLASS__, 'report_statuses' ) );
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

	/** Shown after Completed in the status list. */
	public static function add_statuses( $statuses ) {
		$out = array();
		foreach ( $statuses as $key => $label ) {
			$out[ $key ] = $label;
			if ( 'wc-completed' === $key ) {
				$out = array_merge( $out, self::statuses() );
			}
		}
		return array_merge( $out, self::statuses() );
	}

	/** Delivered orders count as sales in WooCommerce's own reports. */
	public static function report_statuses( $statuses ) {
		if ( is_array( $statuses ) && in_array( 'completed', $statuses, true ) ) {
			$statuses[] = 'delivered';
		}
		return $statuses;
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
		if ( ! FFC_Settings::enabled( 'order_events' ) || $from === $to ) {
			return;
		}
		FFC_Outbox::push( 'order', array( 'order_id' => (int) $order_id, 'event' => 'status', 'from' => $from, 'status' => $to ) );
	}
}
