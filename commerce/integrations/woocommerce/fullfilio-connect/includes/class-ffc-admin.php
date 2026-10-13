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
		foreach ( array( 'code', 'retry', 'test', 'disconnect', 'clear_log', 'protect_save', 'tracking_save' ) as $action ) {
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

	public static function handle_protect_save() {
		self::guard( 'protect_save' );
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- guard() checked the nonce.
		$in = array();
		foreach ( array( 'phone_mode', 'bot_mode', 'min_seconds', 'ip_hourly', 'turnstile_site', 'turnstile_secret', 'turnstile_clear' ) as $k ) {
			$in[ $k ] = isset( $_POST[ $k ] ) ? sanitize_text_field( wp_unslash( $_POST[ $k ] ) ) : '';
		}
		// phpcs:enable
		FFC_Protect::save( $in );
		FFC_Log::info( 'Checkout protection settings saved' );
		wp_safe_redirect( self::url( array( 'tab' => 'protect', 'ffc_notice' => rawurlencode( 'Checkout protection saved.' ), 'ffc_type' => 'success' ) ) );
		exit;
	}

	public static function handle_tracking_save() {
		self::guard( 'tracking_save' );
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- guard() checked the nonce.
		$keys = array(
			'meta_on', 'meta_pixel', 'meta_token', 'meta_token_clear', 'meta_test',
			'tiktok_on', 'tiktok_pixel', 'tiktok_token', 'tiktok_token_clear', 'tiktok_test',
			'google_on', 'google_conv_id', 'google_conv_label', 'google_ga4_id', 'google_ga4_secret', 'google_ga4_secret_clear',
			'trigger', 'exclude_low_rr', 'min_rr', 'browser_events', 'browser_purchase',
		);
		$in = array();
		foreach ( $keys as $k ) {
			$in[ $k ] = isset( $_POST[ $k ] ) ? sanitize_text_field( wp_unslash( $_POST[ $k ] ) ) : '';
		}
		// phpcs:enable
		FFC_Tracking::save( $in );
		FFC_Log::info( 'Ad tracking settings saved' );
		wp_safe_redirect( self::url( array( 'tab' => 'tracking', 'ffc_notice' => rawurlencode( 'Ad tracking saved.' ), 'ffc_type' => 'success' ) ) );
		exit;
	}

	// --- page --------------------------------------------------------------------------------------

	const TABS = array(
		'overview' => array( 'Overview', 'Main' ),
		'orders'   => array( 'Orders', 'Main' ),
		'stock'    => array( 'Stock', 'Main' ),
		'protect'  => array( 'Checkout protection', 'Protect' ),
		'tracking' => array( 'Ad tracking', 'Marketing' ),
		'connect'  => array( 'Connection', 'Setup' ),
		'logs'     => array( 'Logs & help', 'Setup' ),
	);

	const STATUS_TONE = array(
		'pending' => 'gray', 'on-hold' => 'amber', 'processing' => 'blue', 'confirmed' => 'indigo', 'shipped' => 'cyan',
		'completed' => 'green', 'delivered' => 'green', 'partial-delivered' => 'teal', 'returning' => 'orange',
		'returned' => 'rose', 'cancelled' => 'red', 'refunded' => 'red', 'failed' => 'red',
	);

	private static function money( $amount ) {
		$symbol = function_exists( 'get_woocommerce_currency_symbol' ) ? html_entity_decode( get_woocommerce_currency_symbol(), ENT_QUOTES, 'UTF-8' ) : ( function_exists( 'get_woocommerce_currency' ) ? get_woocommerce_currency() . ' ' : '' );
		return $symbol . number_format_i18n( (float) $amount, 0 );
	}

	/** Change against the period before, as "+12%" (null when there is nothing to compare). */
	private static function change( $now, $before ) {
		if ( $before <= 0 ) {
			return null;
		}
		$pct = round( ( $now - $before ) / $before * 100 );
		return ( $pct >= 0 ? '+' : '' ) . $pct . '%';
	}

	private static function spark( $values ) {
		$max = max( 1, max( $values ) );
		$n   = count( $values );
		$pts = array();
		foreach ( array_values( $values ) as $i => $v ) {
			$pts[] = round( $i * 100 / max( 1, $n - 1 ), 1 ) . ',' . round( 28 - $v / $max * 24, 1 );
		}
		return '<svg class="ffc-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="' . esc_attr( implode( ' ', $pts ) ) . '" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
	}

	/** Half-circle gauge in 20 segments, like a fuel meter. */
	private static function gauge( $pct ) {
		$out = '<svg viewBox="0 0 200 110" class="ffc-gauge" aria-hidden="true">';
		for ( $i = 0; $i < 20; $i++ ) {
			$a   = M_PI - ( $i + 0.5 ) * M_PI / 20;
			$x1  = 100 + cos( $a ) * 62;
			$y1  = 100 - sin( $a ) * 62;
			$x2  = 100 + cos( $a ) * 90;
			$y2  = 100 - sin( $a ) * 90;
			$on  = ( $i + 0.5 ) * 5 <= $pct;
			$out .= '<line x1="' . round( $x1, 1 ) . '" y1="' . round( $y1, 1 ) . '" x2="' . round( $x2, 1 ) . '" y2="' . round( $y2, 1 ) . '" stroke="' . ( $on ? '#f5c242' : '#2a2a31' ) . '" stroke-width="7" stroke-linecap="round"/>';
		}
		return $out . '</svg>';
	}

	private static function badge( $status ) {
		$tone  = isset( self::STATUS_TONE[ $status ] ) ? self::STATUS_TONE[ $status ] : 'gray';
		$label = function_exists( 'wc_get_order_status_name' ) ? wc_get_order_status_name( $status ) : $status;
		return '<span class="ffc-badge ffc-' . esc_attr( $tone ) . '">' . esc_html( $label ) . '</span>';
	}

	private static function recent_orders( $limit ) {
		if ( ! function_exists( 'wc_get_orders' ) ) {
			return array();
		}
		return (array) wc_get_orders( array( 'limit' => $limit, 'orderby' => 'date', 'order' => 'DESC', 'type' => 'shop_order' ) );
	}

	private static function orders_table( $orders ) {
		if ( ! $orders ) {
			echo '<p class="ffc-muted ffc-pad">No orders yet.</p>';
			return;
		}
		echo '<table class="ffc-tbl"><thead><tr><th>Order</th><th>Customer</th><th>Phone</th><th>Total</th><th>Status</th><th>Placed</th></tr></thead><tbody>';
		foreach ( $orders as $o ) {
			if ( ! $o instanceof WC_Order ) {
				continue;
			}
			$name = trim( $o->get_billing_first_name() . ' ' . $o->get_billing_last_name() );
			$date = $o->get_date_created();
			$risk = $o->get_meta( '_ffc_risk' );
			$risk = $risk ? json_decode( (string) $risk, true ) : null;
			echo '<tr><td><a href="' . esc_url( $o->get_edit_order_url() ) . '">#' . esc_html( $o->get_order_number() ) . '</a>'
				. ( is_array( $risk ) && $risk['score'] >= 40 ? ' <span class="ffc-badge ffc-amber" title="' . esc_attr( implode( ', ', $risk['reasons'] ) ) . '">risk ' . esc_html( (string) $risk['score'] ) . '</span>' : '' ) . '</td>'
				. '<td>' . esc_html( '' !== $name ? $name : '—' ) . '</td><td class="ffc-mono">' . esc_html( (string) $o->get_billing_phone() ) . '</td>'
				. '<td>' . esc_html( self::money( $o->get_total() ) ) . '</td><td>' . self::badge( $o->get_status() ) . '</td>' // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- badge() escapes.
				. '<td class="ffc-muted">' . esc_html( $date ? $date->date_i18n( 'M j, H:i' ) : '' ) . '</td></tr>';
		}
		echo '</tbody></table>';
	}

	private static function styles() {
		echo '<style>
.ffc-app{--bg:#0c0c0f;--panel:#141418;--line:#24242b;--text:#ececf1;--muted:#8d8d98;--accent:#9aa5ff;display:grid;grid-template-columns:210px minmax(0,1fr);background:var(--bg);color:var(--text);border-radius:18px;margin:14px 20px 0 0;min-height:680px;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;overflow:hidden}
.ffc-app a{color:var(--accent)}.ffc-side{border-right:1px solid var(--line);padding:18px 12px;display:flex;flex-direction:column;gap:4px}
.ffc-brand{display:flex;align-items:center;gap:10px;padding:4px 8px 16px;font-weight:600;font-size:14px}.ffc-brand img{height:28px;max-width:120px;object-fit:contain}
.ffc-mark{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;background:#fff;color:#000;font-weight:800}
.ffc-group{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);padding:14px 10px 4px}
.ffc-nav{display:block;padding:8px 10px;border-radius:9px;color:#c9c9d2!important;text-decoration:none}.ffc-nav:hover{background:#1a1a20}.ffc-nav.on{background:#1f1f27;color:#fff!important;box-shadow:inset 3px 0 0 var(--accent)}
.ffc-version{margin-top:auto;padding:10px;color:var(--muted);font-size:11px}
.ffc-main{padding:22px 24px;min-width:0}.ffc-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.ffc-head h1{color:#fff;font-size:20px;margin:0;font-weight:600}
.ffc-cols{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:16px}@media(max-width:1280px){.ffc-cols{grid-template-columns:1fr}}
.ffc-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}@media(max-width:1100px){.ffc-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
.ffc-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:16px}.ffc-card h2{color:#fff;font-size:14px;font-weight:600;margin:0 0 12px;display:flex;justify-content:space-between;align-items:center}
.ffc-stat{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px;display:flex;justify-content:space-between;gap:8px}.ffc-stat>div{min-width:0}.ffc-stat small{color:var(--muted);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ffc-stat b{font-size:22px;color:#fff;font-weight:600;white-space:nowrap}.ffc-stat .ffc-chg{font-size:11px;color:#57d38c;margin-left:6px}.ffc-stat .ffc-chg.down{color:#ff7a7a}
.ffc-spark{width:64px;height:30px;flex:none;color:var(--accent);align-self:end}
.ffc-bars{display:flex;align-items:flex-end;gap:8px;height:190px;padding-top:8px}.ffc-bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;justify-content:flex-end}.ffc-bar i{display:block;width:100%;max-width:38px;border-radius:9px;background:#2a2a33;min-height:4px}.ffc-bar.top i{background:var(--accent)}.ffc-bar span{font-size:10px;color:var(--muted)}
.ffc-tbl{width:100%;border-collapse:collapse}.ffc-tbl th{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);text-align:left;font-weight:500;padding:8px 10px;border-bottom:1px solid var(--line)}.ffc-tbl td{padding:10px;border-bottom:1px solid #1d1d23;color:#dcdce3}.ffc-tbl tr:last-child td{border-bottom:0}
.ffc-badge{display:inline-block;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:2px 8px;border-radius:6px;background:#26262e;color:#c8c8d2}
.ffc-green{background:#10331f;color:#5ee08f}.ffc-blue{background:#112640;color:#6fb1ff}.ffc-indigo{background:#1d1f45;color:#a3acff}.ffc-cyan{background:#0f3138;color:#5ad8e8}.ffc-teal{background:#0f3330;color:#4fd1b8}.ffc-amber{background:#3a2a0c;color:#f5c242}.ffc-orange{background:#3b220f;color:#ff9f5a}.ffc-rose{background:#3d1525;color:#ff7aa8}.ffc-red{background:#3d1414;color:#ff7a7a}
.ffc-muted{color:var(--muted)}.ffc-mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}.ffc-pad{padding:6px 2px}
.ffc-btn{display:inline-flex;align-items:center;gap:6px;border-radius:10px;border:1px solid var(--line);background:#1c1c23;color:#fff;padding:8px 12px;font-size:12px;cursor:pointer;text-decoration:none}.ffc-btn.primary{background:var(--accent);border-color:var(--accent);color:#0c0c0f;font-weight:600}.ffc-btn:hover{filter:brightness(1.1)}
.ffc-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ffc-dot{display:inline-block;width:8px;height:8px;border-radius:4px;background:#57d38c;margin-right:6px}.ffc-dot.warn{background:#f5c242}.ffc-dot.fail{background:#ff7a7a}
.ffc-gauge{width:100%;max-width:220px;display:block;margin:0 auto}.ffc-gauge-n{text-align:center;margin-top:-34px;font-size:26px;color:#fff;font-weight:600}
.ffc-feed{list-style:none;margin:0;padding:0}.ffc-feed li{background:#1a1a20;border-radius:10px;padding:9px 11px;margin-bottom:8px}.ffc-feed small{display:block;color:var(--muted);font-size:11px}
.ffc-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}.ffc-feat{background:#1a1a20;border-radius:10px;padding:10px 12px}
.ffc-form label{display:block;color:#fff;font-weight:600;margin:14px 0 6px}.ffc-form select,.ffc-form input[type=text],.ffc-form input[type=number],.ffc-form input[type=password],.ffc-app textarea{background:#0f0f13;border:1px solid var(--line);color:#fff;border-radius:9px;padding:7px 10px;min-width:260px}
.ffc-choice{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.ffc-choice label{margin:0;font-weight:400;background:#1a1a20;border:1px solid var(--line);border-radius:10px;padding:10px 12px;cursor:pointer}.ffc-choice b{display:block;color:#fff}.ffc-choice input{margin-right:6px}
.ffc-app details summary{cursor:pointer;color:var(--accent)}
.ffc-mods{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:16px}@media(max-width:1100px){.ffc-mods{grid-template-columns:1fr}}
.ffc-mod{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px}
.ffc-mod-h{display:flex;align-items:flex-start;gap:12px}.ffc-mod-h>div{min-width:0;flex:1}.ffc-mod-h h3{margin:0;color:#fff;font-size:14px;font-weight:600}.ffc-mod-h p{margin:3px 0 0;color:var(--muted);font-size:12px;line-height:1.4}
.ffc-mod-ic{width:38px;height:38px;border-radius:11px;display:inline-flex;align-items:center;justify-content:center;flex:none;font-size:18px}
.ffc-mod-body{display:grid;gap:10px}.ffc-mod-body .ffc-field{margin:0}.ffc-mod-body input[type=text],.ffc-mod-body input[type=password]{min-width:0;width:100%}
.ffc-field{display:grid;gap:5px}.ffc-field small{color:var(--muted);font-size:11px}.ffc-field label.ffc-switch{margin:0}
.ffc-switch{position:relative;display:inline-block;width:42px;height:24px;flex:none}.ffc-switch input{opacity:0;width:0;height:0;position:absolute}
.ffc-switch span{position:absolute;inset:0;background:#2a2a33;border-radius:999px;transition:.2s;cursor:pointer}
.ffc-switch span:before{content:"";position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 2px rgba(0,0,0,.4)}
.ffc-switch input:checked+span{background:#2f6bff}.ffc-switch input:checked+span:before{transform:translateX(18px)}
.ffc-status{font-size:11px;font-weight:600;margin-top:2px}
</style>';
	}

	public static function page() {
		if ( ! current_user_can( self::cap() ) ) {
			return;
		}
		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- display only.
		$tab    = isset( $_GET['tab'] ) ? sanitize_key( wp_unslash( $_GET['tab'] ) ) : 'overview';
		$notice = isset( $_GET['ffc_notice'] ) ? sanitize_text_field( wp_unslash( $_GET['ffc_notice'] ) ) : '';
		$type   = isset( $_GET['ffc_type'] ) ? sanitize_key( wp_unslash( $_GET['ffc_type'] ) ) : 'success';
		// phpcs:enable
		$tab  = isset( self::TABS[ $tab ] ) ? $tab : 'overview';
		$c    = FFC_Settings::connection();
		$logo = $c && ! empty( $c['app_logo'] ) ? $c['app_logo'] : '';
		$name = $c && ! empty( $c['app_name'] ) ? $c['app_name'] : 'Fullfilio';

		echo '<div class="wrap ffc-wrap"><h1 class="screen-reader-text">' . esc_html( $name ) . ' Connect</h1>';
		if ( $notice ) {
			echo '<div class="notice notice-' . esc_attr( in_array( $type, array( 'success', 'error', 'warning' ), true ) ? $type : 'info' ) . '"><p>' . esc_html( $notice ) . '</p></div>';
		}
		self::styles();
		echo '<div class="ffc-app"><nav class="ffc-side"><div class="ffc-brand">' . ( $logo ? '<img src="' . esc_url( $logo ) . '" alt="">' : '<span class="ffc-mark">' . esc_html( strtoupper( substr( $name, 0, 1 ) ) ) . '</span>' ) . '<span>' . esc_html( $name ) . ' Connect</span></div>';
		$group = '';
		foreach ( self::TABS as $key => $t ) {
			if ( $t[1] !== $group ) {
				$group = $t[1];
				echo '<div class="ffc-group">' . esc_html( $group ) . '</div>';
			}
			echo '<a class="ffc-nav' . ( $key === $tab ? ' on' : '' ) . '" href="' . esc_url( self::url( array( 'tab' => $key ) ) ) . '">' . esc_html( $t[0] ) . '</a>';
		}
		echo '<div class="ffc-version">Version ' . esc_html( FFC_VERSION ) . '</div></nav><main class="ffc-main">';
		echo '<div class="ffc-head"><h1>' . esc_html( self::TABS[ $tab ][0] ) . '</h1>' . self::connection_chip( $c ) . '</div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- connection_chip() escapes.
		call_user_func( array( __CLASS__, 'tab_' . $tab ), $c, $name );
		echo '</main></div></div>';
	}

	private static function connection_chip( $c ) {
		$state = FFC_Settings::state();
		if ( ! $c ) {
			return '<span class="ffc-badge ffc-amber">Not connected</span>';
		}
		return empty( $state['last_error'] ) ? '<span class="ffc-badge ffc-green">Connected</span>' : '<span class="ffc-badge ffc-amber" title="' . esc_attr( $state['last_error'] ) . '">Connected · last contact failed</span>';
	}

	private static function connect_steps() {
		echo '<ol style="margin-left:18px"><li>In Fullfilio open <strong>Sales channels → WooCommerce → Connect</strong>.</li><li>Enter this store\'s address: <code>' . esc_html( home_url() ) . '</code> and approve the access WooCommerce asks for.</li><li>Fullfilio connects this plugin by itself. Nothing to copy.</li></ol>';
		echo '<details><summary>Fullfilio cannot reach this site? Paste the connection code instead</summary><form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:8px">';
		wp_nonce_field( 'ffc_code' );
		echo '<input type="hidden" name="action" value="ffc_code"><textarea name="code" rows="3" style="width:100%;max-width:640px" placeholder="ffc1.…" required></textarea><p><button class="ffc-btn primary" type="submit">Connect with code</button></p></form></details>';
	}

	// --- tabs ------------------------------------------------------------------------------------

	private static function tab_overview( $c, $name ) {
		$week     = FFC_Stats::series( 14 );
		$orders   = wp_list_pluck( $week, 'orders' );
		$revenue  = wp_list_pluck( $week, 'revenue' );
		$leads    = wp_list_pluck( $week, 'leads' );
		$stopped  = array_map( static function ( $d ) { return $d['blocked'] + $d['flagged']; }, $week );
		$cards    = array(
			array( 'Orders', FFC_Stats::total( 'orders' ), FFC_Stats::total( 'orders', 7, 7 ), $orders, false ),
			array( 'Order value', FFC_Stats::total( 'revenue' ), FFC_Stats::total( 'revenue', 7, 7 ), $revenue, true ),
			array( 'Unfinished checkouts', FFC_Stats::total( 'leads' ), FFC_Stats::total( 'leads', 7, 7 ), $leads, false ),
			array( 'Stopped or flagged', FFC_Stats::total( 'blocked' ) + FFC_Stats::total( 'flagged' ), FFC_Stats::total( 'blocked', 7, 7 ) + FFC_Stats::total( 'flagged', 7, 7 ), $stopped, false ),
		);
		if ( ! $c ) {
			echo '<div class="ffc-card"><h2>Connect this store</h2>';
			self::connect_steps();
			echo '</div>';
		}
		echo '<p class="ffc-muted" style="margin:-8px 0 10px">Last 7 days, compared with the 7 days before</p><div class="ffc-cards">';
		foreach ( $cards as $k ) {
			$chg = self::change( $k[1], $k[2] );
			echo '<div class="ffc-stat"><div><small>' . esc_html( $k[0] ) . '</small><b>' . esc_html( $k[4] ? self::money( $k[1] ) : number_format_i18n( $k[1] ) ) . '</b>' . ( $chg ? '<span class="ffc-chg' . ( '-' === $chg[0] ? ' down' : '' ) . '">' . esc_html( $chg ) . '</span>' : '' ) . '</div>' . self::spark( array_slice( $k[3], -7 ) ) . '</div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- spark() builds numbers only.
		}
		echo '</div><div class="ffc-cols"><div>';

		// Orders per day.
		$max = max( 1, max( $orders ) );
		$top = array_search( max( $orders ), $orders, true );
		echo '<div class="ffc-card"><h2>Orders, last 14 days <span class="ffc-muted" style="font-weight:400;font-size:12px">counted since the plugin was installed</span></h2><div class="ffc-bars">';
		foreach ( $week as $i => $d ) {
			$h = max( 3, round( $d['orders'] / $max * 100 ) );
			echo '<div class="ffc-bar' . ( $d['orders'] > 0 && $i === $top ? ' top' : '' ) . '" title="' . esc_attr( sprintf( '%s: %d orders · %s', wp_date( 'M j', strtotime( $d['day'] ) ), $d['orders'], self::money( $d['revenue'] ) ) ) . '"><i style="height:' . esc_attr( (string) $h ) . '%"></i><span>' . esc_html( wp_date( 'j', strtotime( $d['day'] ) ) ) . '</span></div>';
		}
		echo '</div></div>';

		echo '<div class="ffc-card"><h2>Recent orders <a class="ffc-btn" href="' . esc_url( self::url( array( 'tab' => 'orders' ) ) ) . '">All</a></h2>';
		self::orders_table( self::recent_orders( 8 ) );
		echo '</div></div><div>';

		// Right column: connection, delivery health, activity.
		$state = FFC_Settings::state();
		echo '<div class="ffc-card"><h2>' . esc_html( $name ) . '</h2>';
		if ( $c ) {
			echo '<p><span class="ffc-dot' . ( empty( $state['last_error'] ) ? '' : ' warn' ) . '"></span>Connected since ' . esc_html( wp_date( 'M j, Y', strtotime( $c['paired_at'] ) ) ) . '</p><p class="ffc-muted">Last contact ' . esc_html( isset( $state['last_ok_at'] ) ? $state['last_ok_at'] : 'never' ) . '</p><div class="ffc-row">';
			self::button( 'test', 'Test connection', 'ffc-btn primary' );
			if ( $c['app_url'] ) {
				echo '<a class="ffc-btn" href="' . esc_url( $c['app_url'] ) . '" target="_blank" rel="noopener">Open ' . esc_html( $name ) . '</a>';
			}
			echo '</div>';
		} else {
			echo '<p class="ffc-muted">Not connected yet.</p>';
		}
		echo '</div>';

		$q    = FFC_Outbox::stats();
		$done = $q['sent'] + $q['failed'];
		$pct  = $done > 0 ? round( $q['sent'] / $done * 100, 1 ) : 100;
		echo '<div class="ffc-card"><h2>Delivery to ' . esc_html( $name ) . '</h2>' . self::gauge( $pct ) . '<div class="ffc-gauge-n">' . esc_html( (string) $pct ) . '%</div><p class="ffc-muted" style="text-align:center">' . esc_html( sprintf( 'delivered · %d waiting · %d failed', $q['pending'] + $q['sending'], $q['failed'] ) ) . '</p>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- gauge() builds numbers only.
		if ( $q['failed'] > 0 ) {
			echo '<div class="ffc-row" style="justify-content:center">';
			self::button( 'retry', 'Send again', 'ffc-btn primary' );
			echo '</div>';
		}
		echo '</div>';

		$feed = array();
		foreach ( FFC_Log::recent( 6 ) as $l ) {
			$feed[] = array( 'at' => $l['at'], 'text' => $l['message'], 'kind' => $l['level'] );
		}
		foreach ( FFC_Protect::recent( 4 ) as $p ) {
			$feed[] = array( 'at' => $p['at'] . 'Z', 'text' => ( 'bot_flagged' === $p['kind'] ? 'Flagged ' : 'Stopped ' ) . $p['phone'] . ': ' . $p['why'], 'kind' => 'protect' );
		}
		foreach ( FFC_Stock::recent( 4 ) as $m ) {
			$feed[] = array( 'at' => $m['at'] . 'Z', 'text' => sprintf( '+%d %s back in stock (#%s)', $m['added'], $m['product'], $m['order'] ), 'kind' => 'stock' );
		}
		usort( $feed, static function ( $a, $b ) { return strcmp( $b['at'], $a['at'] ); } );
		echo '<div class="ffc-card"><h2>Activity</h2>';
		if ( ! $feed ) {
			echo '<p class="ffc-muted">Nothing yet.</p>';
		} else {
			echo '<ul class="ffc-feed">';
			foreach ( array_slice( $feed, 0, 7 ) as $f ) {
				echo '<li>' . esc_html( $f['text'] ) . '<small>' . esc_html( wp_date( 'M j, H:i', strtotime( $f['at'] ) ) ) . '</small></li>';
			}
			echo '</ul>';
		}
		echo '</div></div></div>';
	}

	private static function tab_orders( $c, $name ) {
		echo '<div class="ffc-card"><h2>Latest orders</h2>';
		self::orders_table( self::recent_orders( 25 ) );
		echo '</div><div class="ffc-card"><h2>Statuses ' . esc_html( $name ) . ' sets</h2><div class="ffc-row">';
		foreach ( array( 'confirmed', 'shipped', 'delivered', 'partial-delivered', 'returning', 'returned', 'cancelled' ) as $st ) {
			echo self::badge( $st ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- badge() escapes.
		}
		echo '</div><p class="ffc-muted">The WooCommerce order follows the order in ' . esc_html( $name ) . ' from Confirmed on. A status set by ' . esc_html( $name ) . ' is not sent back to it.</p></div>';
	}

	private static function tab_stock( $c, $name ) {
		$st = FFC_Stock::summary();
		echo '<div class="ffc-cards">';
		foreach ( array( array( 'Tracked products', $st['tracked'] ), array( 'Low (≤ ' . $st['threshold'] . ')', $st['low'] ), array( 'Out of stock', $st['out'] ), array( 'Put back · 7 days', array_sum( array_map( static function ( $m ) { return strtotime( $m['at'] . ' UTC' ) > time() - WEEK_IN_SECONDS ? (int) $m['added'] : 0; }, FFC_Stock::recent( 200 ) ) ) ) ) as $k ) {
			echo '<div class="ffc-stat"><div><small>' . esc_html( $k[0] ) . '</small><b>' . esc_html( number_format_i18n( $k[1] ) ) . '</b></div></div>';
		}
		echo '</div><div class="ffc-card"><h2>Who keeps the count</h2><p>' . ( FFC_Stock::managed_by_fullfilio()
			? '<strong>' . esc_html( $name ) . ' keeps the count.</strong> <span class="ffc-muted">It sends each product\'s stock here. Orders still take stock off at checkout; cancels and returns are counted in ' . esc_html( $name ) . ', so they are not put back here twice.</span>'
			: '<strong>WooCommerce keeps the count.</strong> <span class="ffc-muted">A cancel puts items back the WooCommerce way. Items that come back to ' . esc_html( $name ) . ' (a return, or the undelivered part of a partial delivery) are put back here automatically, once.</span>' ) . '</p></div>';
		if ( $st['low_items'] ) {
			echo '<div class="ffc-card"><h2>Low or out of stock</h2><table class="ffc-tbl"><thead><tr><th>Product</th><th>SKU</th><th>Stock</th></tr></thead><tbody>';
			foreach ( $st['low_items'] as $it ) {
				echo '<tr><td>' . ( $it['edit'] ? '<a href="' . esc_url( $it['edit'] ) . '">' . esc_html( $it['name'] ) . '</a>' : esc_html( $it['name'] ) ) . '</td><td class="ffc-mono">' . esc_html( (string) $it['sku'] ) . '</td><td>' . esc_html( (string) $it['stock'] ) . '</td></tr>';
			}
			echo '</tbody></table></div>';
		}
		$moves = FFC_Stock::recent( 15 );
		echo '<div class="ffc-card"><h2>Put back by ' . esc_html( $name ) . '</h2>';
		if ( ! $moves ) {
			echo '<p class="ffc-muted">Nothing yet. Returned items show here when they are put back.</p>';
		} else {
			echo '<table class="ffc-tbl"><thead><tr><th>When (UTC)</th><th>Order</th><th>Product</th><th>Added</th><th>Stock after</th><th>Why</th></tr></thead><tbody>';
			foreach ( $moves as $m ) {
				$order = ! empty( $m['order_id'] ) && function_exists( 'wc_get_order' ) ? wc_get_order( $m['order_id'] ) : null;
				$link  = $order ? $order->get_edit_order_url() : '';
				echo '<tr><td>' . esc_html( $m['at'] ) . '</td><td>' . ( $link ? '<a href="' . esc_url( $link ) . '">#' . esc_html( (string) $m['order'] ) . '</a>' : '#' . esc_html( (string) $m['order'] ) ) . '</td><td>' . esc_html( $m['product'] ) . '</td><td>+' . esc_html( (string) $m['added'] ) . '</td><td>' . esc_html( null === $m['stock'] ? '?' : (string) $m['stock'] ) . '</td><td class="ffc-muted">' . esc_html( $m['reason'] ) . '</td></tr>';
			}
			echo '</tbody></table>';
		}
		echo '</div>';
	}

	private static function tab_protect( $c, $name ) {
		$s     = FFC_Protect::settings();
		$radio = static function ( $field, $value, $title, $text ) use ( $s ) {
			return '<label><input type="radio" name="' . esc_attr( $field ) . '" value="' . esc_attr( $value ) . '"' . checked( $s[ $field ], $value, false ) . '><b>' . esc_html( $title ) . '</b><span class="ffc-muted">' . esc_html( $text ) . '</span></label>';
		};
		echo '<form class="ffc-form" method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( 'ffc_protect_save' );
		echo '<input type="hidden" name="action" value="ffc_protect_save">';
		echo '<div class="ffc-card"><h2>Phone number check</h2><p class="ffc-muted">Checked on the server when the order is placed (it cannot be skipped from the browser). The order keeps the clean 01XXXXXXXXX number.</p><div class="ffc-choice">'
			. $radio( 'phone_mode', 'off', 'Off', 'Any number is accepted.' )
			. $radio( 'phone_mode', 'normal', 'Normal', 'Only Bangladeshi mobile numbers (01[3-9] and 8 digits; +880 is fine).' )
			. $radio( 'phone_mode', 'strict', 'Strict', 'Also refuses made-up numbers like 01711111111 or 01712345678.' )
			. '</div></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $radio escapes.
		echo '<div class="ffc-card"><h2>Bot and fake order protection</h2><p class="ffc-muted">Looks for no typing or tapping on the checkout, an order sent within seconds, a script instead of a browser, a hidden field filled in, and many orders from one IP.</p><div class="ffc-choice">'
			. $radio( 'bot_mode', 'off', 'Off', 'No bot check.' )
			. $radio( 'bot_mode', 'flag', 'Flag only', 'The order goes through; it gets a risk note you can see on the order.' )
			. $radio( 'bot_mode', 'block', 'Block', 'High-risk checkouts are refused with a friendly message.' )
			. '</div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $radio escapes.
		echo '<label for="ffc-min">Seconds a person needs at least</label><input id="ffc-min" type="number" min="0" max="60" name="min_seconds" value="' . esc_attr( (string) $s['min_seconds'] ) . '"> <span class="ffc-muted">from opening the checkout to placing the order (0 = no limit)</span>';
		echo '<label for="ffc-ip">Orders per IP per hour</label><input id="ffc-ip" type="number" min="1" max="50" name="ip_hourly" value="' . esc_attr( (string) $s['ip_hourly'] ) . '"> <span class="ffc-muted">more than this counts as a risk</span>';
		echo '<label for="ffc-ts">Cloudflare Turnstile (optional)</label><p class="ffc-muted" style="margin-top:0">A free invisible check from Cloudflare on the classic checkout. Create a widget at dash.cloudflare.com → Turnstile and paste its keys.</p>';
		echo '<input id="ffc-ts" type="text" name="turnstile_site" placeholder="Site key" value="' . esc_attr( $s['turnstile_site'] ) . '"> <input type="password" name="turnstile_secret" autocomplete="new-password" placeholder="' . esc_attr( $s['turnstile_secret'] ? 'Secret key saved — leave empty to keep it' : 'Secret key' ) . '">';
		if ( $s['turnstile_secret'] ) {
			echo ' <label style="display:inline;font-weight:400"><input type="checkbox" name="turnstile_clear" value="1"> Remove the keys</label>';
		}
		echo '</div><p><button class="ffc-btn primary" type="submit">Save protection</button></p></form>';

		$log = FFC_Protect::recent( 25 );
		echo '<div class="ffc-card"><h2>Stopped or flagged</h2>';
		if ( ! $log ) {
			echo '<p class="ffc-muted">Nothing stopped or flagged yet.</p>';
		} else {
			echo '<table class="ffc-tbl"><thead><tr><th>When (UTC)</th><th>What</th><th>Phone</th><th>Risk</th><th>Why</th></tr></thead><tbody>';
			$what = array( 'phone' => array( 'Wrong number', 'red' ), 'bot_blocked' => array( 'Blocked', 'red' ), 'bot_flagged' => array( 'Flagged', 'amber' ) );
			foreach ( $log as $l ) {
				$w = isset( $what[ $l['kind'] ] ) ? $what[ $l['kind'] ] : array( $l['kind'], 'gray' );
				echo '<tr><td>' . esc_html( $l['at'] ) . '</td><td><span class="ffc-badge ffc-' . esc_attr( $w[1] ) . '">' . esc_html( $w[0] ) . '</span></td><td class="ffc-mono">' . esc_html( $l['phone'] ) . '</td><td>' . esc_html( null === $l['score'] ? '—' : (string) $l['score'] ) . '</td><td class="ffc-muted">' . esc_html( $l['why'] ) . '</td></tr>';
			}
			echo '</tbody></table>';
		}
		echo '</div>';
	}

	private static function tab_tracking( $c, $name ) {
		$s   = FFC_Tracking::settings();
		$sw  = static function ( $field, $on ) {
			return '<label class="ffc-switch"><input type="checkbox" name="' . esc_attr( $field ) . '" value="1"' . checked( $on, true, false ) . '><span></span></label>';
		};
		$tok = static function ( $field, $has ) {
			return '<input type="password" name="' . esc_attr( $field ) . '" autocomplete="new-password" placeholder="' . esc_attr( $has ? 'Saved — leave empty to keep it' : 'Access token' ) . '">'
				. ( $has ? '<label style="font-weight:400;color:var(--muted)"><input type="checkbox" name="' . esc_attr( $field ) . '_clear" value="1"> Remove the token</label>' : '' );
		};
		$icon = static function ( $bg, $letter ) {
			return '<span class="ffc-mod-ic" style="background:' . esc_attr( $bg ) . ';color:#fff;font-weight:800">' . esc_html( $letter ) . '</span>';
		};
		$field = static function ( $label, $input, $hint = '' ) {
			return '<div class="ffc-field"><small>' . esc_html( $label ) . '</small>' . $input . ( $hint ? '<small>' . esc_html( $hint ) . '</small>' : '' ) . '</div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $input is built from esc_attr'd fields above.
		};

		echo '<form class="ffc-form" method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( 'ffc_tracking_save' );
		echo '<input type="hidden" name="action" value="ffc_tracking_save">';
		echo '<p class="ffc-muted" style="margin:-4px 0 12px">Turn on your own ad pixels. The conversion is <strong>held</strong> and only sent once the order is call-confirmed — and never for a low-receive-rate customer — so the ad platforms learn from orders that actually get received.</p>';

		echo '<div class="ffc-mods">';

		// Meta
		$on = $s['meta']['on'] ? 'Active' : 'Off';
		echo '<div class="ffc-mod"><div class="ffc-mod-h">' . $icon( '#1877f2', 'f' ) . '<div><h3>Meta — Pixel + Conversions API</h3><p>Facebook & Instagram. Browser Pixel plus server-side CAPI with fbc/fbp click ids and one event id to de-duplicate.</p></div>' . $sw( 'meta_on', $s['meta']['on'] ) . '</div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo '<div class="ffc-mod-body">'
			. $field( 'Pixel ID (dataset ID)', '<input type="text" name="meta_pixel" value="' . esc_attr( $s['meta']['pixel'] ) . '" placeholder="123456789012345">' )
			. $field( 'Conversions API access token', $tok( 'meta_token', ! empty( $s['meta']['token'] ) ) )
			. $field( 'Test event code (optional)', '<input type="text" name="meta_test" value="' . esc_attr( $s['meta']['test'] ) . '" placeholder="TEST12345">', 'From Events Manager → Test events. Leave empty for live.' )
			. '</div><div class="ffc-status ffc-muted">Status: ' . esc_html( $on ) . '</div></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped

		// TikTok
		$on = $s['tiktok']['on'] ? 'Active' : 'Off';
		echo '<div class="ffc-mod"><div class="ffc-mod-h">' . $icon( '#000', 'T' ) . '<div><h3>TikTok — Pixel + Events API</h3><p>Browser Pixel plus server-side Events API with the ttclid click id. CompletePayment on confirm.</p></div>' . $sw( 'tiktok_on', $s['tiktok']['on'] ) . '</div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo '<div class="ffc-mod-body">'
			. $field( 'Pixel ID', '<input type="text" name="tiktok_pixel" value="' . esc_attr( $s['tiktok']['pixel'] ) . '" placeholder="CXXXXXXXXXXXXXXXXXXX">' )
			. $field( 'Events API access token', $tok( 'tiktok_token', ! empty( $s['tiktok']['token'] ) ) )
			. $field( 'Test event code (optional)', '<input type="text" name="tiktok_test" value="' . esc_attr( $s['tiktok']['test'] ) . '" placeholder="TEST12345">' )
			. '</div><div class="ffc-status ffc-muted">Status: ' . esc_html( $on ) . '</div></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped

		// Google
		$on = $s['google']['on'] ? 'Active' : 'Off';
		echo '<div class="ffc-mod"><div class="ffc-mod-h">' . $icon( '#ea4335', 'G' ) . '<div><h3>Google — Ads + GA4 (Enhanced Conversions)</h3><p>gtag in the browser plus server-side GA4 Measurement Protocol with hashed customer data; the purchase imports into Google Ads.</p></div>' . $sw( 'google_on', $s['google']['on'] ) . '</div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo '<div class="ffc-mod-body">'
			. $field( 'Google Ads conversion ID', '<input type="text" name="google_conv_id" value="' . esc_attr( $s['google']['conv_id'] ) . '" placeholder="AW-123456789">' )
			. $field( 'Conversion label (optional)', '<input type="text" name="google_conv_label" value="' . esc_attr( $s['google']['conv_label'] ) . '" placeholder="abcDEF123">' )
			. $field( 'GA4 Measurement ID', '<input type="text" name="google_ga4_id" value="' . esc_attr( $s['google']['ga4_id'] ) . '" placeholder="G-XXXXXXX">' )
			. $field( 'GA4 Measurement Protocol API secret', str_replace( 'Access token', 'API secret', $tok( 'google_ga4_secret', ! empty( $s['google']['ga4_secret'] ) ) ) )
			. '</div><div class="ffc-status ffc-muted">Status: ' . esc_html( $on ) . '</div></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped

		echo '</div>'; // /ffc-mods

		// Sending rules
		echo '<div class="ffc-card"><h2>Sending rules</h2>';
		echo '<label>When to count the conversion</label><div class="ffc-choice">'
			. '<label><input type="radio" name="trigger" value="confirmed"' . checked( $s['trigger'], 'confirmed', false ) . '><b>On call confirmation</b><span class="ffc-muted">Sent when the order reaches Confirmed (the call confirmed it). Recommended.</span></label>'
			. '<label><input type="radio" name="trigger" value="delivered"' . checked( $s['trigger'], 'delivered', false ) . '><b>On delivery only</b><span class="ffc-muted">Held until the parcel is Delivered. The purest signal, but slower.</span></label>'
			. '</div>';
		echo '<div class="ffc-field" style="margin-top:12px"><label class="ffc-row" style="font-weight:600;color:#fff">' . $sw( 'exclude_low_rr', $s['exclude_low_rr'] ) . '<span style="margin-left:4px">Skip low-receive-rate customers</span></label><small class="ffc-muted">Do not send a conversion for a customer whose courier receive rate is below the limit (Fullfilio provides the rate; a shield "advance/block" also counts as low).</small></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo '<label for="ffc-rr">Lowest receive rate to send (%)</label><input id="ffc-rr" type="number" min="0" max="100" name="min_rr" value="' . esc_attr( (string) $s['min_rr'] ) . '"> <span class="ffc-muted">orders below this are not sent</span>';
		echo '<div class="ffc-field" style="margin-top:12px"><label class="ffc-row" style="font-weight:600;color:#fff">' . $sw( 'browser_events', $s['browser_events'] ) . '<span style="margin-left:4px">Fire funnel events in the browser</span></label><small class="ffc-muted">PageView, ViewContent, InitiateCheckout and AddToCart. Purchase stays server-side.</small></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo '<div class="ffc-field" style="margin-top:8px"><label class="ffc-row" style="font-weight:600;color:#fff">' . $sw( 'browser_purchase', $s['browser_purchase'] ) . '<span style="margin-left:4px">Also fire Purchase in the browser on the thank-you page</span></label><small class="ffc-muted">Off by default — this would count orders that are not yet confirmed. The same event id de-duplicates with the server event if you turn it on.</small></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo '<p style="margin-top:14px"><button class="ffc-btn primary" type="submit">Save ad tracking</button></p></div></form>';

		// Recent sends
		$rows = FFC_Tracking::recent( 20 );
		echo '<div class="ffc-card"><h2>Recently sent</h2>';
		if ( ! $rows ) {
			echo '<p class="ffc-muted">Nothing sent yet. Conversions appear here when a confirmed order is sent to your pixels.</p>';
		} else {
			echo '<table class="ffc-tbl"><thead><tr><th>When (UTC)</th><th>Order</th><th>Sent to</th><th>Problems</th></tr></thead><tbody>';
			foreach ( $rows as $r ) {
				echo '<tr><td>' . esc_html( $r['at'] ) . '</td><td>#' . esc_html( $r['order'] ) . '</td><td>' . esc_html( $r['sent'] ? implode( ', ', $r['sent'] ) : '—' ) . '</td><td class="ffc-muted">' . esc_html( $r['errors'] ? implode( ' | ', $r['errors'] ) : '' ) . '</td></tr>';
			}
			echo '</tbody></table>';
		}
		echo '</div>';
	}

	private static function tab_connect( $c, $name ) {
		$state = FFC_Settings::state();
		$cfg   = FFC_Settings::config();
		echo '<div class="ffc-card"><h2>Connection</h2>';
		if ( $c ) {
			echo '<p><span class="ffc-dot' . ( empty( $state['last_error'] ) ? '' : ' warn' ) . '"></span>Connected to <strong>' . esc_html( $c['app_name'] ) . '</strong>' . ( $c['app_url'] ? ' (<a href="' . esc_url( $c['app_url'] ) . '" target="_blank" rel="noopener">open</a>)' : '' ) . ' since ' . esc_html( $c['paired_at'] ) . '.</p>';
			echo '<p class="ffc-muted">Store id ' . esc_html( $c['channel_id'] ) . ' · last contact ' . esc_html( isset( $state['last_ok_at'] ) ? $state['last_ok_at'] : 'never' ) . ( ! empty( $state['last_error'] ) ? ' · last problem: ' . esc_html( $state['last_error'] ) : '' ) . '</p><div class="ffc-row">';
			self::button( 'test', 'Test connection', 'ffc-btn primary' );
			self::button( 'disconnect', 'Disconnect', 'ffc-btn' );
			echo '</div>';
		} else {
			self::connect_steps();
		}
		echo '</div>';
		$labels = array(
			'order_events'    => array( 'Instant orders', 'New orders and status changes are queued for ' . $name . ' the moment they happen.' ),
			'capture_leads'   => array( 'Unfinished checkouts', 'Phone, name, address and cart from checkouts that were not completed.' ),
			'attribution'     => array( 'Ad attribution', 'UTM tags, click ids and Meta cookies saved on each order.' ),
			'shield'          => array( 'Order shield', 'Block-listed numbers are stopped; low delivery success asks for an advance (no cash on delivery).' ),
			'custom_statuses' => array( 'Order statuses', 'Confirmed, Shipped, Delivered, Partially delivered, Return in transit and Returned follow the order in ' . $name . '.' ),
			'stock_sync'      => array( $name . ' keeps the stock', $name . ' sends the stock count; WooCommerce does not put stock back on a cancel (no double count).' ),
		);
		echo '<div class="ffc-card"><h2>What is switched on</h2><p class="ffc-muted">Change these in ' . esc_html( $name ) . ' (the store\'s page). They arrive here with the next contact.</p><div class="ffc-grid2">';
		foreach ( $labels as $key => $l ) {
			echo '<div class="ffc-feat"><span class="ffc-dot' . ( ! empty( $cfg[ $key ] ) ? '' : ' warn' ) . '"></span><strong>' . esc_html( $l[0] ) . '</strong><br><span class="ffc-muted">' . esc_html( ! empty( $cfg[ $key ] ) ? $l[1] : 'Off' ) . '</span></div>';
		}
		echo '</div></div>';
	}

	private static function tab_logs( $c, $name ) {
		echo '<div class="ffc-card"><h2>Troubleshooting</h2><table class="ffc-tbl"><tbody>';
		foreach ( FFC_Health::checks() as $check ) {
			echo '<tr><td style="width:20px"><span class="ffc-dot' . ( 'ok' === $check['status'] ? '' : ( 'fail' === $check['status'] ? ' fail' : ' warn' ) ) . '"></span></td><td><strong>' . esc_html( $check['label'] ) . '</strong></td><td class="ffc-muted">' . esc_html( $check['detail'] ) . '</td></tr>';
		}
		echo '</tbody></table></div>';

		$stats = FFC_Outbox::stats();
		echo '<div class="ffc-card"><h2>Delivery queue</h2><p>' . esc_html( sprintf( '%d waiting · %d failed · %d sent in the last week', $stats['pending'] + $stats['sending'], $stats['failed'], $stats['sent'] ) ) . '</p>';
		if ( $stats['failed'] > 0 ) {
			self::button( 'retry', 'Send again', 'ffc-btn primary' );
		}
		$rows = FFC_Outbox::recent( 15 );
		if ( $rows ) {
			echo '<table class="ffc-tbl" style="margin-top:8px"><thead><tr><th>Event</th><th>Status</th><th>Tries</th><th>Created (UTC)</th><th>Problem</th></tr></thead><tbody>';
			foreach ( $rows as $r ) {
				echo '<tr><td>' . esc_html( $r['type'] ) . '</td><td>' . esc_html( $r['status'] ) . '</td><td>' . esc_html( $r['attempts'] ) . '</td><td>' . esc_html( $r['created_at'] ) . '</td><td class="ffc-muted">' . esc_html( (string) $r['last_error'] ) . '</td></tr>';
			}
			echo '</tbody></table>';
		}
		echo '</div><div class="ffc-card"><h2>Debug log</h2>';
		$log = FFC_Log::recent( 40 );
		if ( ! $log ) {
			echo '<p class="ffc-muted">Nothing logged yet.</p>';
		} else {
			echo '<table class="ffc-tbl"><tbody>';
			foreach ( $log as $line ) {
				echo '<tr><td style="white-space:nowrap">' . esc_html( $line['at'] ) . '</td><td>' . esc_html( $line['level'] ) . '</td><td>' . esc_html( $line['message'] ) . ( $line['context'] ? ' <span class="ffc-muted">' . esc_html( wp_json_encode( $line['context'] ) ) . '</span>' : '' ) . '</td></tr>';
			}
			echo '</tbody></table><p>';
			self::button( 'clear_log', 'Clear log', 'ffc-btn' );
			echo '</p>';
		}
		echo '</div>';
	}
}
