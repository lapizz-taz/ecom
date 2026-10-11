<?php
/**
 * Health: a report Fullfilio shows on the store's page (and the plugin page
 * shows here), sent every 15 minutes as a heartbeat and on request.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Health {
	const HOOK = 'ffc_heartbeat';

	public static function init() {
		add_filter( 'cron_schedules', array( __CLASS__, 'cron_schedules' ) ); // phpcs:ignore WordPress.WP.CronInterval.ChangeDetected
		add_action( self::HOOK, array( __CLASS__, 'beat' ) );
		// Belt and braces: WP-Cron also drains the queue, in case Action Scheduler is not running.
		add_action( self::HOOK, array( 'FFC_Outbox', 'flush' ), 20 );
		if ( ! wp_next_scheduled( self::HOOK ) ) {
			self::schedule();
		}
	}

	public static function cron_schedules( $schedules ) {
		$schedules['ffc_15min'] = array( 'interval' => 15 * MINUTE_IN_SECONDS, 'display' => 'Every 15 minutes (Fullfilio)' );
		return $schedules;
	}

	public static function schedule() {
		add_filter( 'cron_schedules', array( __CLASS__, 'cron_schedules' ) ); // phpcs:ignore WordPress.WP.CronInterval.ChangeDetected
		if ( ! wp_next_scheduled( self::HOOK ) ) {
			wp_schedule_event( time() + 60, 'ffc_15min', self::HOOK );
		}
	}

	public static function unschedule() {
		wp_clear_scheduled_hook( self::HOOK );
		wp_clear_scheduled_hook( FFC_Outbox::HOOK );
	}

	public static function beat() {
		if ( ! FFC_Settings::connected() ) {
			return;
		}
		// Sent directly, not through the queue: it is its own retry every 15 minutes.
		$r = FFC_Api::send( 'heartbeat', self::report(), null, 10 );
		FFC_Settings::set_state( array( 'last_heartbeat_at' => gmdate( 'c' ), 'last_heartbeat_ok' => $r['ok'] ) );
		if ( ! $r['ok'] ) {
			FFC_Log::warning( 'Heartbeat to Fullfilio failed: ' . $r['error'] );
		}
	}

	/** Uses the block checkout (Store API) rather than the [woocommerce_checkout] shortcode. */
	private static function checkout_type() {
		if ( ! function_exists( 'wc_get_page_id' ) ) {
			return 'unknown';
		}
		$page = wc_get_page_id( 'checkout' );
		if ( $page <= 0 ) {
			return 'missing';
		}
		$content = (string) get_post_field( 'post_content', $page );
		if ( has_block( 'woocommerce/checkout', $content ) ) {
			return 'blocks';
		}
		return has_shortcode( $content, 'woocommerce_checkout' ) ? 'classic' : 'other';
	}

	/** Fullfilio's webhooks in WooCommerce (WooCommerce pauses one after repeated failed deliveries). */
	private static function webhooks() {
		$c = FFC_Settings::connection();
		if ( ! $c || ! class_exists( 'WC_Data_Store' ) ) {
			return array();
		}
		$out = array();
		try {
			$store = WC_Data_Store::load( 'webhook' );
			foreach ( (array) $store->search_webhooks( array( 'limit' => 100 ) ) as $id ) {
				$hook = wc_get_webhook( $id );
				if ( $hook && false !== strpos( (string) $hook->get_delivery_url(), $c['channel_id'] ) ) {
					$out[] = array( 'id' => (int) $id, 'topic' => $hook->get_topic(), 'status' => $hook->get_status(), 'failures' => (int) $hook->get_failure_count() );
				}
			}
		} catch ( Exception $e ) {
			$out[] = array( 'error' => $e->getMessage() );
		}
		return $out;
	}

	/**
	 * Versions, queue, checks.
	 *
	 * @param bool $details Include the latest log lines and queue rows.
	 */
	public static function report( $details = false ) {
		global $wp_version;
		$hpos = class_exists( '\Automattic\WooCommerce\Utilities\OrderUtil' ) && \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled();
		$out  = array(
			'plugin_version' => FFC_VERSION,
			'wordpress'      => $wp_version,
			'woocommerce'    => defined( 'WC_VERSION' ) ? WC_VERSION : null,
			'php'            => PHP_VERSION,
			'site_url'       => home_url(),
			'currency'       => function_exists( 'get_woocommerce_currency' ) ? get_woocommerce_currency() : null,
			'timezone'       => wp_timezone_string(),
			'hpos'           => $hpos,
			'checkout'       => self::checkout_type(),
			'permalinks'     => get_option( 'permalink_structure' ) ? 'pretty' : 'plain',
			'https'          => is_ssl() || 0 === strpos( home_url(), 'https://' ),
			'wp_cron'        => ! ( defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ),
			'action_scheduler' => function_exists( 'as_enqueue_async_action' ),
			'features'       => FFC_Settings::config(),
			'stock_keeper'   => FFC_Stock::managed_by_fullfilio() ? 'fullfilio' : 'woocommerce',
			'outbox'         => FFC_Outbox::stats(),
			'webhooks'       => self::webhooks(),
			'state'          => array_intersect_key( FFC_Settings::state(), array_flip( array( 'last_ok_at', 'last_error', 'last_error_at', 'last_heartbeat_at' ) ) ),
		);
		if ( $details ) {
			$out['log']    = FFC_Log::recent( 30 );
			$out['recent'] = FFC_Outbox::recent( 20 );
		}
		return $out;
	}

	/**
	 * Things worth fixing, for the Troubleshooting box.
	 *
	 * @return array<int, array{status:string,label:string,detail:string}>
	 */
	public static function checks() {
		$r      = self::report();
		$checks = array();
		$add    = static function ( $ok, $label, $good, $bad, $warn = false ) use ( &$checks ) {
			$checks[] = array( 'status' => $ok ? 'ok' : ( $warn ? 'warn' : 'fail' ), 'label' => $label, 'detail' => $ok ? $good : $bad );
		};
		$add( ffc_woocommerce_active(), 'WooCommerce', 'Active (' . ( $r['woocommerce'] ? $r['woocommerce'] : '?' ) . ')', 'WooCommerce is not active — install and activate it first.' );
		$add( FFC_Settings::connected(), 'Connected to Fullfilio', 'Yes', 'Not yet — connect the store from Fullfilio (Sales channels → WooCommerce).' );
		$add( 'pretty' === $r['permalinks'], 'Permalinks', 'Pretty permalinks are on', 'Settings → Permalinks: choose any option except "Plain", or the WooCommerce REST API cannot be reached.' );
		$add( $r['https'], 'Secure address (HTTPS)', 'Yes', 'The site is not on HTTPS. Fullfilio needs HTTPS to connect with API keys.' );
		$add( $r['wp_cron'] || $r['action_scheduler'], 'Background tasks', $r['action_scheduler'] ? 'Action Scheduler is available' : 'WP-Cron is on', 'WP-Cron is disabled and Action Scheduler is missing — events wait until a real cron job runs wp-cron.php.', true );
		$add( in_array( $r['checkout'], array( 'classic', 'blocks' ), true ), 'Checkout page', ucfirst( $r['checkout'] ) . ' checkout', 'No standard checkout page was found; unfinished-checkout capture may not see the form.', true );
		$failed = (int) $r['outbox']['failed'];
		$add( 0 === $failed, 'Delivery queue', $r['outbox']['pending'] . ' waiting', $failed . ' event(s) could not be delivered — see the queue below and click "Send again".', ! FFC_Settings::connected() );
		$paused = array_filter( $r['webhooks'], static function ( $w ) {
			return isset( $w['status'] ) && 'active' !== $w['status'];
		} );
		$add( ! $paused, 'WooCommerce webhooks', count( $r['webhooks'] ) . ' active', count( $paused ) . ' webhook(s) paused by WooCommerce after failed deliveries — Fullfilio switches them back on at its next check, or click "Fix webhooks" there.', true );
		$state = FFC_Settings::state();
		$add( empty( $state['last_error'] ), 'Last contact', ! empty( $state['last_ok_at'] ) ? 'OK at ' . $state['last_ok_at'] : 'No contact yet', isset( $state['last_error'] ) ? (string) $state['last_error'] : '', true );
		return $checks;
	}
}
