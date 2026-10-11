<?php
/**
 * WooCommerce → Fullfilio: connection, what is switched on, the delivery
 * queue, troubleshooting checks and the debug log. Everything is set up from
 * Fullfilio; this page shows the state and offers the manual fallbacks.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Admin {
	const SLUG = 'fullfilio-connect';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ), 60 );
		add_action( 'admin_notices', array( __CLASS__, 'notices' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( FFC_FILE ), array( __CLASS__, 'links' ) );
		foreach ( array( 'code', 'retry', 'test', 'disconnect', 'clear_log' ) as $action ) {
			add_action( 'admin_post_ffc_' . $action, array( __CLASS__, 'handle_' . $action ) );
		}
	}

	public static function url( $args = array() ) {
		return add_query_arg( $args, admin_url( 'admin.php?page=' . self::SLUG ) );
	}

	public static function links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( self::url() ) . '">' . esc_html__( 'Settings', 'fullfilio-connect' ) . '</a>' );
		return $links;
	}

	public static function menu() {
		// Without WooCommerce the page sits under Settings so the admin can still see why nothing syncs.
		add_submenu_page( ffc_woocommerce_active() ? 'woocommerce' : 'options-general.php', 'Fullfilio', 'Fullfilio', self::cap(), self::SLUG, array( __CLASS__, 'page' ) );
	}

	/** WooCommerce gives shop managers manage_woocommerce; without WooCommerce only site admins see the page. */
	private static function cap() {
		return ffc_woocommerce_active() ? 'manage_woocommerce' : 'manage_options';
	}

	public static function notices() {
		if ( ! current_user_can( self::cap() ) ) {
			return;
		}
		if ( ! ffc_woocommerce_active() ) {
			echo '<div class="notice notice-error"><p><strong>Fullfilio Connect</strong> needs WooCommerce. Install and activate WooCommerce first.</p></div>';
			return;
		}
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( ! FFC_Settings::connected() && $screen && 'plugins' === $screen->id ) {
			echo '<div class="notice notice-info"><p><strong>Fullfilio Connect</strong> is installed. Finish in Fullfilio: <em>Sales channels → WooCommerce → Connect</em>. <a href="' . esc_url( self::url() ) . '">Open the plugin page</a></p></div>';
		}
	}

	private static function guard( $action ) {
		if ( ! current_user_can( self::cap() ) ) {
			wp_die( esc_html__( 'You are not allowed to do this.', 'fullfilio-connect' ), 403 );
		}
		check_admin_referer( 'ffc_' . $action );
	}

	private static function back( $notice, $type = 'success' ) {
		wp_safe_redirect( self::url( array( 'ffc_notice' => rawurlencode( $notice ), 'ffc_type' => $type ) ) );
		exit;
	}

	public static function handle_code() {
		self::guard( 'code' );
		$code   = isset( $_POST['code'] ) ? sanitize_text_field( wp_unslash( $_POST['code'] ) ) : '';
		$parsed = FFC_Settings::parse_code( $code );
		$saved  = is_wp_error( $parsed ) ? $parsed : FFC_Settings::save_connection( $parsed );
		if ( is_wp_error( $saved ) ) {
			self::back( $saved->get_error_message(), 'error' );
		}
		FFC_Health::schedule();
		$r = FFC_Api::send( 'heartbeat', FFC_Health::report(), null, 15 );
		FFC_Log::info( 'Connected with a connection code' );
		self::back( $r['ok'] ? 'Connected. Fullfilio received this store\'s first report.' : 'Saved, but Fullfilio could not be reached: ' . $r['error'], $r['ok'] ? 'success' : 'warning' );
	}

	public static function handle_retry() {
		self::guard( 'retry' );
		$n = FFC_Outbox::retry_failed();
		$r = FFC_Outbox::flush();
		self::back( sprintf( '%d event(s) queued again: %d sent, %d still waiting, %d failed.', $n, $r['sent'], $r['waiting'], $r['failed'] ) );
	}

	public static function handle_test() {
		self::guard( 'test' );
		$r = FFC_Api::send( 'heartbeat', FFC_Health::report(), null, 15 );
		self::back( $r['ok'] ? 'Fullfilio answered. The connection works.' : 'Fullfilio did not answer: ' . $r['error'], $r['ok'] ? 'success' : 'error' );
	}

	public static function handle_disconnect() {
		self::guard( 'disconnect' );
		FFC_Settings::forget_connection();
		FFC_Log::info( 'Disconnected on the plugin page' );
		self::back( 'Disconnected. Orders still reach Fullfilio through WooCommerce webhooks until you disconnect the store there too.' );
	}

	public static function handle_clear_log() {
		self::guard( 'clear_log' );
		FFC_Log::clear();
		self::back( 'Log cleared.' );
	}

	private static function button( $action, $label, $class = 'button' ) {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:inline-block;margin-right:6px">';
		wp_nonce_field( 'ffc_' . $action );
		echo '<input type="hidden" name="action" value="ffc_' . esc_attr( $action ) . '">';
		echo '<button type="submit" class="' . esc_attr( $class ) . '">' . esc_html( $label ) . '</button></form>';
	}

	private static function pill( $status ) {
		$map = array( 'ok' => array( '#0a7d33', '✓' ), 'warn' => array( '#a86b00', '!' ), 'fail' => array( '#b32d2e', '✕' ) );
		$p   = isset( $map[ $status ] ) ? $map[ $status ] : $map['warn'];
		return '<span style="display:inline-block;width:18px;height:18px;border-radius:9px;background:' . esc_attr( $p[0] ) . ';color:#fff;text-align:center;line-height:18px;font-size:11px;font-weight:700">' . esc_html( $p[1] ) . '</span>';
	}

	public static function page() {
		if ( ! current_user_can( self::cap() ) ) {
			return;
		}
		$c     = FFC_Settings::connection();
		$state = FFC_Settings::state();
		$cfg   = FFC_Settings::config();
		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- display only.
		$notice = isset( $_GET['ffc_notice'] ) ? sanitize_text_field( wp_unslash( $_GET['ffc_notice'] ) ) : '';
		$type   = isset( $_GET['ffc_type'] ) ? sanitize_key( wp_unslash( $_GET['ffc_type'] ) ) : 'success';
		// phpcs:enable
		echo '<div class="wrap"><h1>Fullfilio Connect</h1>';
		if ( $notice ) {
			echo '<div class="notice notice-' . esc_attr( in_array( $type, array( 'success', 'error', 'warning' ), true ) ? $type : 'info' ) . '"><p>' . esc_html( $notice ) . '</p></div>';
		}
		echo '<style>.ffc-card{background:#fff;border:1px solid #dcdcde;border-radius:8px;padding:16px 20px;margin:16px 0;max-width:980px}.ffc-card h2{margin-top:0;font-size:15px}.ffc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 16px}.ffc-muted{color:#646970}.ffc-table td,.ffc-table th{padding:6px 8px}</style>';

		// Connection.
		echo '<div class="ffc-card"><h2>Connection</h2>';
		if ( $c ) {
			echo '<p>' . self::pill( empty( $state['last_error'] ) ? 'ok' : 'warn' ) . ' Connected to <strong>' . esc_html( $c['app_name'] ) . '</strong>' . ( $c['app_url'] ? ' (<a href="' . esc_url( $c['app_url'] ) . '" target="_blank" rel="noopener">open</a>)' : '' ) . ' since ' . esc_html( $c['paired_at'] ) . '.</p>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- pill() escapes.
			echo '<p class="ffc-muted">Store id ' . esc_html( $c['channel_id'] ) . ' · last contact ' . esc_html( isset( $state['last_ok_at'] ) ? $state['last_ok_at'] : 'never' ) . ( ! empty( $state['last_error'] ) ? ' · last problem: ' . esc_html( $state['last_error'] ) : '' ) . '</p>';
			self::button( 'test', 'Test connection', 'button button-primary' );
			self::button( 'disconnect', 'Disconnect' );
		} else {
			echo '<ol><li>In Fullfilio open <strong>Sales channels → WooCommerce → Connect</strong>.</li><li>Enter this store\'s address: <code>' . esc_html( home_url() ) . '</code> and approve the access WooCommerce asks for.</li><li>Fullfilio connects this plugin by itself. Nothing to copy.</li></ol>';
			echo '<details><summary>Fullfilio cannot reach this site? Paste the connection code instead</summary><form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:8px">';
			wp_nonce_field( 'ffc_code' );
			echo '<input type="hidden" name="action" value="ffc_code"><textarea name="code" rows="3" style="width:100%;max-width:640px" placeholder="ffc1.…" required></textarea><p><button class="button button-primary" type="submit">Connect with code</button></p></form></details>';
		}
		echo '</div>';

		// Features (decided in Fullfilio).
		$labels = array(
			'order_events'  => array( 'Instant orders', 'New orders and status changes are queued for Fullfilio the moment they happen.' ),
			'capture_leads' => array( 'Unfinished checkouts', 'Phone, name, address and cart from checkouts that were not completed.' ),
			'attribution'   => array( 'Ad attribution', 'UTM tags, click ids and Meta cookies saved on each order.' ),
			'shield'        => array( 'Order shield', 'Block-listed numbers are stopped; low delivery success asks for an advance (no cash on delivery).' ),
			'custom_statuses' => array( 'Delivered / Returned statuses', 'Two order statuses Fullfilio sets when the courier reports it.' ),
		);
		echo '<div class="ffc-card"><h2>What is switched on</h2><p class="ffc-muted">Change these in Fullfilio (the store\'s page). They arrive here with the next contact.</p><div class="ffc-grid">';
		foreach ( $labels as $key => $l ) {
			echo '<div>' . self::pill( ! empty( $cfg[ $key ] ) ? 'ok' : 'warn' ) . ' <strong>' . esc_html( $l[0] ) . '</strong><br><span class="ffc-muted">' . esc_html( ! empty( $cfg[ $key ] ) ? $l[1] : 'Off' ) . '</span></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- pill() escapes.
		}
		echo '</div></div>';

		// Troubleshooting.
		echo '<div class="ffc-card"><h2>Troubleshooting</h2><table class="ffc-table">';
		foreach ( FFC_Health::checks() as $check ) {
			echo '<tr><td>' . self::pill( $check['status'] ) . '</td><td><strong>' . esc_html( $check['label'] ) . '</strong></td><td class="ffc-muted">' . esc_html( $check['detail'] ) . '</td></tr>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- pill() escapes.
		}
		echo '</table></div>';

		// Queue.
		$stats = FFC_Outbox::stats();
		echo '<div class="ffc-card"><h2>Delivery queue</h2><p>' . esc_html( sprintf( '%d waiting · %d failed · %d sent in the last week', $stats['pending'] + $stats['sending'], $stats['failed'], $stats['sent'] ) ) . '</p>';
		if ( $stats['failed'] > 0 ) {
			self::button( 'retry', 'Send again', 'button button-primary' );
		}
		$rows = FFC_Outbox::recent( 15 );
		if ( $rows ) {
			echo '<table class="widefat striped ffc-table" style="margin-top:8px"><thead><tr><th>Event</th><th>Status</th><th>Tries</th><th>Created (UTC)</th><th>Problem</th></tr></thead><tbody>';
			foreach ( $rows as $r ) {
				echo '<tr><td>' . esc_html( $r['type'] ) . '</td><td>' . esc_html( $r['status'] ) . '</td><td>' . esc_html( $r['attempts'] ) . '</td><td>' . esc_html( $r['created_at'] ) . '</td><td class="ffc-muted">' . esc_html( (string) $r['last_error'] ) . '</td></tr>';
			}
			echo '</tbody></table>';
		}
		echo '</div>';

		// Log.
		echo '<div class="ffc-card"><h2>Debug log</h2>';
		$log = FFC_Log::recent( 40 );
		if ( ! $log ) {
			echo '<p class="ffc-muted">Nothing logged yet.</p>';
		} else {
			echo '<table class="widefat striped ffc-table"><tbody>';
			foreach ( $log as $line ) {
				echo '<tr><td style="white-space:nowrap">' . esc_html( $line['at'] ) . '</td><td>' . esc_html( $line['level'] ) . '</td><td>' . esc_html( $line['message'] ) . ( $line['context'] ? ' <span class="ffc-muted">' . esc_html( wp_json_encode( $line['context'] ) ) . '</span>' : '' ) . '</td></tr>';
			}
			echo '</tbody></table><p>';
			self::button( 'clear_log', 'Clear log' );
			echo '</p>';
		}
		echo '</div><p class="ffc-muted">Fullfilio Connect ' . esc_html( FFC_VERSION ) . '</p></div>';
	}
}
