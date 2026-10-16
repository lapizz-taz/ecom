<?php
/**
 * WooCommerce → Fullfilio: connection, what is switched on, the delivery
 * queue, checkout protection, ad tracking, troubleshooting and the debug log.
 *
 * The page is a quiet, minimal look in Poppins (bundled with the plugin): a
 * white header band with the page name, version and the Fullfilio logo,
 * underline tabs, and module cards (title, what it does, then a footer with
 * its status and switch).
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

	private static function back( $notice, $type = 'success', $tab = '' ) {
		$args = array( 'ffc_notice' => rawurlencode( $notice ), 'ffc_type' => $type );
		if ( $tab ) {
			$args['tab'] = $tab;
		}
		wp_safe_redirect( self::url( $args ) );
		exit;
	}

	public static function handle_code() {
		self::guard( 'code' );
		$code   = isset( $_POST['code'] ) ? sanitize_text_field( wp_unslash( $_POST['code'] ) ) : '';
		$parsed = FFC_Settings::parse_code( $code );
		$saved  = is_wp_error( $parsed ) ? $parsed : FFC_Settings::save_connection( $parsed );
		if ( is_wp_error( $saved ) ) {
			self::back( $saved->get_error_message(), 'error', 'connect' );
		}
		FFC_Health::schedule();
		$r = FFC_Api::send( 'heartbeat', FFC_Health::report(), null, 15 );
		FFC_Log::info( 'Connected with a connection code' );
		self::back( $r['ok'] ? 'Connected. Fullfilio received this store\'s first report.' : 'Saved, but Fullfilio could not be reached: ' . $r['error'], $r['ok'] ? 'success' : 'warning', 'connect' );
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
		self::back( $r['ok'] ? 'Fullfilio answered. The connection works.' : 'Fullfilio did not answer: ' . $r['error'], $r['ok'] ? 'success' : 'error', 'connect' );
	}

	public static function handle_disconnect() {
		self::guard( 'disconnect' );
		FFC_Settings::forget_connection();
		FFC_Log::info( 'Disconnected on the plugin page' );
		self::back( 'Disconnected. Orders still reach Fullfilio through WooCommerce webhooks until you disconnect the store there too.', 'success', 'connect' );
	}

	public static function handle_clear_log() {
		self::guard( 'clear_log' );
		FFC_Log::clear();
		self::back( 'Log cleared.', 'success', 'logs' );
	}

	/** A one-button form (admin-post with its own nonce). */
	private static function button( $action, $label, $class = 'ffc-btn', $icon = '' ) {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" class="ffc-inline">';
		wp_nonce_field( 'ffc_' . $action );
		echo '<input type="hidden" name="action" value="ffc_' . esc_attr( $action ) . '">';
		echo '<button type="submit" class="' . esc_attr( $class ) . '">' . ( $icon ? self::icon( $icon ) : '' ) . esc_html( $label ) . '</button></form>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- icon() returns fixed SVG.
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
		self::back( 'Checkout protection saved.', 'success', 'protect' );
	}

	public static function handle_tracking_save() {
		self::guard( 'tracking_save' );
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- guard() checked the nonce.
		$keys = array_merge(
			array(
				'meta_on', 'meta_pixel', 'meta_token', 'meta_token_clear', 'meta_test',
				'tiktok_on', 'tiktok_pixel', 'tiktok_token', 'tiktok_token_clear', 'tiktok_test',
				'google_on', 'google_conv_id', 'google_conv_label', 'google_ga4_id', 'google_ga4_secret', 'google_ga4_secret_clear',
				'trigger', 'min_rr', 'dup_hours',
			),
			FFC_Tracking::FLAGS
		);
		$in = array();
		foreach ( $keys as $k ) {
			$in[ $k ] = isset( $_POST[ $k ] ) ? sanitize_text_field( wp_unslash( $_POST[ $k ] ) ) : '';
		}
		$test = isset( $_POST['ffc_test'] ) ? sanitize_key( wp_unslash( $_POST['ffc_test'] ) ) : '';
		// phpcs:enable
		FFC_Tracking::save( $in );
		FFC_Log::info( 'Ad tracking settings saved' );
		if ( in_array( $test, array( 'meta', 'tiktok', 'google' ), true ) ) {
			$r = FFC_Tracking::test( $test );
			self::back( 'Saved. ' . $r['message'], $r['ok'] ? 'success' : ( ! empty( $r['hint'] ) ? 'warning' : 'error' ), 'tracking' );
		}
		self::back( 'Ad tracking saved.', 'success', 'tracking' );
	}

	// --- look ----------------------------------------------------------------------------------

	const TABS = array(
		'overview' => array( 'Overview', 'dashboard', 'Orders, unfinished checkouts and delivery to %s at a glance.' ),
		'orders'   => array( 'Orders', 'orders', 'The latest WooCommerce orders and the statuses %s sets on them.' ),
		'stock'    => array( 'Stock', 'stock', 'Who keeps the stock count, what is running low and what came back.' ),
		'protect'  => array( 'Checkout protection', 'shield', 'Stop wrong numbers, bots and fake orders before they are placed.' ),
		'tracking' => array( 'Ad tracking', 'target', 'Meta, TikTok and Google — browser and server, de-duplicated, counted when the order really counts.' ),
		'connect'  => array( 'Connection', 'plug', 'How this store is connected to %s and what it shares.' ),
		'logs'     => array( 'Logs & help', 'help', 'Checks, the delivery queue and the debug log.' ),
	);

	const STATUS_TONE = array(
		'pending' => 'gray', 'on-hold' => 'amber', 'processing' => 'blue', 'confirmed' => 'indigo', 'shipped' => 'cyan',
		'completed' => 'green', 'delivered' => 'green', 'partial-delivered' => 'teal', 'returning' => 'orange',
		'returned' => 'rose', 'cancelled' => 'red', 'refunded' => 'red', 'failed' => 'red',
	);

	/** Lucide-style line icons (fixed markup). */
	const ICONS = array(
		'dashboard' => '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
		'orders'    => '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
		'stock'     => '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/>',
		'shield'    => '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
		'target'    => '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
		'plug'      => '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
		'help'      => '<circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/><circle cx="12" cy="12" r="4"/>',
		'refresh'   => '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
		'check'     => '<path d="M20 6 9 17l-5-5"/>',
		'external'  => '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
		'download'  => '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
		'phone'     => '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
		'bot'       => '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
		'cloud'     => '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
		'inbox'     => '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
		'cart'      => '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
		'megaphone' => '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
		'tag'       => '<path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.41l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1"/>',
		'power'     => '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
		'trash'     => '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
		'send'      => '<path d="M14.54 21.69a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.64l-19 6.5a.5.5 0 0 0-.03.94l7.93 3.18a2 2 0 0 1 1.11 1.11z"/><path d="m21.85 2.15-10.94 10.94"/>',
	);

	/** The Fullfilio app icon and wordmark (same artwork as the app's logo). */
	private static function logo() {
		$word = array(
			'M75,224C82,198 88,176 94,152C100,122 116,98 150,95H311L240,165H158C138,166 124,173 113,184C100,196 90,210 81,223C79,226 76,226 75,224Z',
			'M157,214H238L168,284H86Z',
			'M298,132H349V231A25,25 0 0 0 399,231V132H450V238A45,45 0 0 1 405,283H303Q298,283 298,278V233H346L298,178Z',
			'M467,70H512V283H467Z',
			'M529,70H574V283H529Z',
			'M616,283V110A40,40 0 0 1 656,70H705V108H660V134H698V170H660V283ZM590,134H616V170H590Z',
			'M721,70H772V115H758L721,139.7Z',
			'M721,157.5L756,134H772V283H721Z',
			'M789,70H834V283H789Z',
			'M876.5,63A26,26 0 1 1 876.5,115A26,26 0 1 1 876.5,63Z',
			'M854,134H899V283H854Z',
			'M972,117H1083V231H1028V175H919V170Z',
			'M916,178H974V233H1083L1033,283H916Z',
		);
		$paths = '';
		foreach ( $word as $d ) {
			$paths .= '<path d="' . $d . '" fill-rule="evenodd"/>';
		}
		return '<svg class="ffc-mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#2142e7"/><g fill="#fff" stroke="#fff" stroke-width="1" stroke-linejoin="round"><path d="M8 24 24 8H56V38H40V24Z"/><path d="M8 26H24V40H56L40 56H8Z"/></g></svg>'
			. '<svg class="ffc-word" viewBox="73 60 1015 226" aria-hidden="true">' . $paths . '</svg>';
	}

	private static function icon( $name ) {
		return isset( self::ICONS[ $name ] ) ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' . self::ICONS[ $name ] . '</svg>' : '';
	}

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

	/** Half-circle gauge in 20 segments. */
	private static function gauge( $pct ) {
		$out = '<svg viewBox="0 0 200 110" class="ffc-gauge" aria-hidden="true">';
		for ( $i = 0; $i < 20; $i++ ) {
			$a   = M_PI - ( $i + 0.5 ) * M_PI / 20;
			$on  = ( $i + 0.5 ) * 5 <= $pct;
			$out .= '<line x1="' . round( 100 + cos( $a ) * 62, 1 ) . '" y1="' . round( 100 - sin( $a ) * 62, 1 ) . '" x2="' . round( 100 + cos( $a ) * 90, 1 ) . '" y2="' . round( 100 - sin( $a ) * 90, 1 ) . '" stroke="' . ( $on ? '#2142e7' : '#e9eaee' ) . '" stroke-width="7" stroke-linecap="round"/>';
		}
		return $out . '</svg>';
	}

	private static function badge( $status ) {
		$tone  = isset( self::STATUS_TONE[ $status ] ) ? self::STATUS_TONE[ $status ] : 'gray';
		$label = function_exists( 'wc_get_order_status_name' ) ? wc_get_order_status_name( $status ) : $status;
		return '<span class="ffc-badge ffc-' . esc_attr( $tone ) . '">' . esc_html( $label ) . '</span>';
	}

	/** A big switch, as in WordPress module screens. */
	private static function switch_input( $field, $on, $disabled = false ) {
		return '<label class="ffc-switch"><input type="checkbox" name="' . esc_attr( $field ) . '" value="1"' . checked( $on, true, false ) . disabled( $disabled, true, false ) . ' aria-label="' . esc_attr( $field ) . '"><span></span></label>';
	}

	/** Footer line: "Status: Active" (green) or "Status: Off". */
	private static function status_text( $on, $extra = '' ) {
		return '<span class="ffc-status">Status: <b class="' . ( $on ? 'ffc-ok' : 'ffc-off' ) . '" data-on="Active" data-off="Off">' . ( $on ? 'Active' : 'Off' ) . '</b>' . $extra . '</span>';
	}

	private static function recent_orders( $limit ) {
		if ( ! function_exists( 'wc_get_orders' ) ) {
			return array();
		}
		return (array) wc_get_orders( array( 'limit' => $limit, 'orderby' => 'date', 'order' => 'DESC', 'type' => 'shop_order' ) );
	}

	private static function orders_table( $orders ) {
		if ( ! $orders ) {
			echo '<p class="ffc-muted">No orders yet.</p>';
			return;
		}
		echo '<div class="ffc-scroll"><table class="ffc-tbl"><thead><tr><th>Order</th><th>Customer</th><th>Phone</th><th>Total</th><th>Status</th><th>Placed</th></tr></thead><tbody>';
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
		echo '</tbody></table></div>';
	}

	private static function styles() {
		$css = <<<'CSS'
@font-face{font-family:"FFC Poppins";font-style:normal;font-weight:400;font-display:swap;src:url(%FONTS%poppins-400.woff2) format("woff2")}
@font-face{font-family:"FFC Poppins";font-style:normal;font-weight:500;font-display:swap;src:url(%FONTS%poppins-500.woff2) format("woff2")}
@font-face{font-family:"FFC Poppins";font-style:normal;font-weight:600;font-display:swap;src:url(%FONTS%poppins-600.woff2) format("woff2")}
.ffc-wrap{--ink:#111318;--text:#3d4150;--muted:#6b7080;--line:#e6e7eb;--soft:#f6f7f9;--brand:#2142e7;--brand-ink:#1a34bf;--brand-soft:#eef1fe;--ok:#0a8a3a;--bad:#d63638;
  margin:0 0 0 -20px;color:var(--ink);font:14px/1.5 "FFC Poppins",Poppins,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--soft);min-height:calc(100vh - 32px)}
@media(max-width:782px){.ffc-wrap{margin-left:-10px}}
.ffc-wrap *{box-sizing:border-box}.ffc-wrap a{color:var(--brand)}
.ffc-wrap button,.ffc-wrap input,.ffc-wrap select,.ffc-wrap textarea{font-family:inherit}
.ffc-in{max-width:1160px;margin:0 auto;padding:0 32px}@media(max-width:782px){.ffc-in{padding:0 16px}}
.ffc-hero{background:#fff;border-bottom:1px solid var(--line);padding:28px 0 0}
.ffc-hero-top{display:flex;align-items:center;justify-content:space-between;gap:24px}.ffc-hero-top>div{min-width:0}
.ffc-eyebrow{font-size:11px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:0 0 6px;display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.ffc-hero h1{font-size:24px;line-height:1.25;font-weight:600;margin:0;padding:0;color:var(--ink);display:flex;align-items:center;flex-wrap:wrap;gap:10px;letter-spacing:-.01em}
.ffc-ver{font-size:11px;font-weight:500;color:var(--muted);background:var(--soft);border:1px solid var(--line);border-radius:999px;padding:2px 9px;line-height:1.4;letter-spacing:0}
.ffc-sub{font-size:14px;color:var(--muted);margin:6px 0 0;max-width:640px}
.ffc-brand{display:flex;align-items:center;gap:12px;flex:none;color:var(--ink)!important;text-decoration:none!important;border-radius:14px}
.ffc-brand:focus,.ffc-brand:active{outline:none!important;box-shadow:none!important}
.ffc-brand:focus-visible{outline:2px solid var(--brand)!important;outline-offset:4px}
.ffc-brand .ffc-mark{width:44px;height:44px;border-radius:12px;box-shadow:0 10px 22px -12px rgba(33,66,231,.75)}
.ffc-brand .ffc-word{height:21px;width:auto;fill:currentColor}
@media(max-width:782px){.ffc-hero-top{align-items:flex-start}.ffc-brand .ffc-word{display:none}.ffc-brand .ffc-mark{width:38px;height:38px}.ffc-hero h1{font-size:20px}}
.ffc-tabs{display:flex;gap:2px;margin:22px -12px 0;padding:0 12px}.ffc-tabs.ffc-scroll{scrollbar-width:none}.ffc-tabs::-webkit-scrollbar{display:none}
.ffc-tab{display:inline-flex;align-items:center;gap:7px;padding:10px 12px 12px;font-size:13px;font-weight:500;color:var(--muted)!important;text-decoration:none!important;white-space:nowrap;border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .15s,border-color .15s}
.ffc-tab svg{width:15px;height:15px;flex:none}.ffc-tab:hover{color:var(--ink)!important}
.ffc-tab.is-on{color:var(--ink)!important;border-bottom-color:var(--brand)}.ffc-tab:focus-visible{outline:2px solid var(--brand);outline-offset:-2px;border-radius:8px}
.ffc-body{padding:24px 0 48px}
.ffc-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:34px;padding:0 14px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--ink)!important;font-size:13px;font-weight:500;line-height:1;cursor:pointer;text-decoration:none!important;white-space:nowrap;box-shadow:0 1px 2px rgba(17,19,24,.05);transition:background-color .15s,border-color .15s}
.ffc-btn:hover{background:var(--soft);border-color:#d6d8de}.ffc-btn:active{transform:translateY(1px)}.ffc-btn:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.ffc-btn svg{width:15px;height:15px;flex:none}
.ffc-btn.primary{background:var(--brand);border-color:var(--brand);color:#fff!important;box-shadow:0 1px 2px rgba(33,66,231,.25)}
.ffc-btn.primary:hover{background:var(--brand-ink);border-color:var(--brand-ink)}
.ffc-btn.danger{color:var(--bad)!important}.ffc-btn.sm{height:28px;padding:0 10px;font-size:12px;border-radius:8px}
.ffc-inline{display:inline-block;margin:0}
.ffc-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ffc-card{background:#fff;border:1px solid var(--line);border-radius:14px;margin-bottom:20px;overflow:hidden}
.ffc-card-h{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:15px 20px;border-bottom:1px solid var(--line)}
.ffc-card-h h2{min-width:0;font-size:15px;font-weight:600;line-height:1.35;margin:0;display:flex;align-items:center;gap:10px;color:var(--ink)}
.ffc-card-h h2>svg{width:18px;height:18px;color:var(--muted);flex:none}
.ffc-card-b{padding:18px 20px}.ffc-card-b>:first-child{margin-top:0}.ffc-card-b>:last-child{margin-bottom:0}
.ffc-card-f{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;background:var(--soft);border-top:1px solid var(--line);min-height:56px}
.ffc-mods{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-bottom:20px}@media(max-width:1000px){.ffc-mods{grid-template-columns:minmax(0,1fr)}}
.ffc-mods .ffc-card{margin:0;display:flex;flex-direction:column}.ffc-mods .ffc-card-b{flex:1}
/* Module tiles are monochrome: one quiet style for every card. */
.ffc-mod-ic{width:30px;height:30px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex:none;font-weight:600;font-size:15px;background:var(--soft)!important;border:1px solid var(--line)!important;color:var(--ink)!important}
.ffc-mod-ic svg{width:16px;height:16px;color:var(--ink)}
.ffc-desc{color:var(--text);margin:0 0 16px;font-size:13.5px;line-height:1.6}
.ffc-status{font-size:13px;color:var(--text);min-width:0;flex:1;display:flex;flex-wrap:wrap;align-items:center;gap:6px}.ffc-card-f .ffc-badge{white-space:normal}
.ffc-ok{color:var(--ok);font-weight:500}.ffc-off{color:var(--muted);font-weight:500}.ffc-bad{color:var(--bad)}
.ffc-switch{position:relative;display:inline-block;width:40px;height:22px;flex:none;margin:0}
.ffc-wrap .ffc-switch input[type=checkbox]{position:absolute;inset:0;width:100%;height:100%;opacity:0!important;margin:0;cursor:pointer;z-index:1;-webkit-appearance:none;appearance:none;border:0;box-shadow:none}.ffc-wrap .ffc-switch input[type=checkbox]::before{display:none!important}
.ffc-switch span{position:absolute;inset:0;background:#d4d6dc;border-radius:999px;transition:background .2s}
.ffc-switch span:before{content:"";position:absolute;width:18px;height:18px;left:2px;top:2px;background:#fff;border-radius:50%;transition:transform .2s;box-shadow:0 1px 2px rgba(17,19,24,.25)}
.ffc-switch input:checked+span{background:var(--brand)}.ffc-switch input:checked+span:before{transform:translateX(18px)}
.ffc-switch input:focus-visible+span{outline:2px solid var(--brand);outline-offset:2px}.ffc-switch input:disabled{cursor:default}.ffc-switch input:disabled+span{opacity:.55}
.ffc-switch.sm{width:34px;height:20px}.ffc-switch.sm span:before{width:16px;height:16px}.ffc-switch.sm input:checked+span:before{transform:translateX(14px)}
.ffc-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:20px}@media(max-width:1100px){.ffc-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){.ffc-stats{gap:10px}.ffc-stat{padding:14px}.ffc-stat b{font-size:19px}.ffc-spark{display:none}}
.ffc-stat{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px 18px;display:flex;justify-content:space-between;align-items:flex-end;gap:8px}.ffc-stat>div{min-width:0}
.ffc-stat small{color:var(--muted);display:block;font-size:12px;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ffc-stat b{font-size:22px;font-weight:600;white-space:nowrap;letter-spacing:-.01em}
.ffc-chg{font-size:11px;font-weight:500;color:var(--ok);margin-left:6px}.ffc-chg.down{color:var(--bad)}
.ffc-spark{width:64px;height:28px;flex:none;color:var(--brand)}
.ffc-cols{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:20px}.ffc-cols>div{min-width:0}@media(max-width:1200px){.ffc-cols{grid-template-columns:minmax(0,1fr)}}
.ffc-bars{display:flex;align-items:flex-end;gap:8px;height:180px}.ffc-bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;justify-content:flex-end}.ffc-bar i{display:block;width:100%;max-width:32px;border-radius:6px 6px 2px 2px;background:#e9eaee;min-height:4px}.ffc-bar.top i{background:var(--brand)}.ffc-bar span{font-size:11px;color:var(--muted)}
.ffc-scroll{overflow-x:auto}
.ffc-tbl{width:100%;border-collapse:collapse;font-size:13px}.ffc-tbl th{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);text-align:left;font-weight:500;padding:8px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
.ffc-tbl td{padding:10px 12px;border-bottom:1px solid #f0f1f4;vertical-align:middle}.ffc-tbl tr:last-child td{border-bottom:0}.ffc-tbl tbody tr:hover td{background:#fafbfc}
.ffc-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:500;padding:2px 9px;border-radius:999px;background:#f0f1f4;color:#4b5060;white-space:nowrap;letter-spacing:0;text-transform:none}
.ffc-badge svg{width:12px;height:12px}.ffc-green{background:#eaf7ee;color:#0a7a33}.ffc-blue{background:var(--brand-soft);color:var(--brand)}.ffc-indigo{background:#eef0ff;color:#4338ca}.ffc-cyan{background:#e9f8fb;color:#0e7490}.ffc-teal{background:#e9f7f4;color:#0f766e}.ffc-amber{background:#fdf6e3;color:#8a5a00}.ffc-orange{background:#fff3ea;color:#c2410c}.ffc-rose{background:#fff0f2;color:#be123c}.ffc-red{background:#fdeeee;color:#b32d2e}
.ffc-muted{color:var(--muted)}.ffc-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.ffc-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#16a34a;margin-right:7px;vertical-align:middle;box-shadow:0 0 0 3px #eaf7ee}.ffc-dot.warn{background:#d99a06;box-shadow:0 0 0 3px #fdf6e3}.ffc-dot.fail{background:var(--bad);box-shadow:0 0 0 3px #fdeeee}
.ffc-gauge{width:100%;max-width:210px;display:block;margin:0 auto}.ffc-gauge-n{text-align:center;margin-top:-34px;font-size:24px;font-weight:600}
.ffc-feed{list-style:none;margin:0;padding:0}.ffc-feed li{background:var(--soft);border-radius:10px;padding:9px 12px;margin-bottom:6px;font-size:13px}.ffc-feed small{display:block;color:var(--muted);font-size:11.5px;margin-top:2px}
.ffc-field{display:grid;gap:6px;margin-bottom:14px}.ffc-field>label{font-weight:500;font-size:13px}.ffc-field small,.ffc-hint{color:var(--muted);font-size:12px;line-height:1.5}
.ffc-wrap input[type=text],.ffc-wrap input[type=number],.ffc-wrap input[type=password],.ffc-wrap textarea,.ffc-wrap select{border:1px solid #d6d8de;border-radius:10px;min-height:38px;padding:0 12px;font-size:13.5px;width:100%;max-width:460px;background:#fff;box-shadow:none;color:var(--ink)}
.ffc-wrap textarea{padding:10px 12px;max-width:100%}.ffc-wrap input:focus,.ffc-wrap textarea:focus,.ffc-wrap select:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft);outline:0}
.ffc-wrap input.ffc-num{width:92px}
.ffc-check{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);font-weight:400}
.ffc-choice{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:12px}
.ffc-choice label{position:relative;display:block;border:1px solid var(--line);border-radius:12px;padding:14px 14px 14px 42px;cursor:pointer;background:#fff;transition:border-color .15s,background-color .15s}
.ffc-choice label:hover{border-color:#cfd2d9}.ffc-choice input{position:absolute;left:14px;top:16px;margin:0}
.ffc-choice label:has(input:checked){border-color:var(--brand);background:var(--brand-soft)}
.ffc-choice b{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;margin-bottom:3px}.ffc-choice span{display:block;color:var(--muted);font-size:12.5px;line-height:1.5}
.ffc-opt{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:14px 0;border-top:1px solid #f0f1f4}.ffc-opt:first-child{border-top:0;padding-top:0}
.ffc-opt b{display:block;font-size:13.5px;font-weight:600;margin-bottom:2px}.ffc-opt p{margin:0;color:var(--muted);font-size:12.5px;line-height:1.55;max-width:720px}.ffc-opt .ffc-row{margin-top:10px}
.ffc-section{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:24px 0 12px}
.ffc-mq{display:grid;grid-template-columns:200px minmax(0,1fr);gap:28px;align-items:center}@media(max-width:900px){.ffc-mq{grid-template-columns:minmax(0,1fr)}}
.ffc-mq-n{font-size:40px;font-weight:600;line-height:1;letter-spacing:-.02em}.ffc-mq-n small{font-size:16px;color:var(--muted);font-weight:400}
.ffc-meter{height:6px;border-radius:99px;background:#e9eaee;overflow:hidden;margin:12px 0 6px}.ffc-meter i{display:block;height:100%;background:var(--brand);border-radius:99px}
.ffc-keys{display:flex;flex-wrap:wrap;gap:6px}.ffc-key{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:12px;background:#fff}
.ffc-key i{width:7px;height:7px;border-radius:50%;background:#c9ccd3}.ffc-key.full i{background:#16a34a}.ffc-key.part i{background:#d99a06}.ffc-key em{font-style:normal;color:var(--muted)}
.ffc-update{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;background:var(--brand-soft);border:1px solid #d6defd;border-radius:12px;padding:10px 14px;margin-top:20px}
.ffc-update p{margin:0;font-size:13.5px}
.ffc-foot{margin:28px 0 0;font-size:12px;color:var(--muted)}
.ffc-wrap details summary{cursor:pointer;color:var(--brand)}
.ffc-wrap code{font-size:12px;background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.ffc-wrap .notice{border-radius:10px}
CSS;
		echo '<style>' . str_replace( '%FONTS%', esc_url( FFC_URL . 'assets/fonts/' ), $css ) . '</style>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- fixed CSS; the font URL is escaped.
	}

	private static function script() {
		// "Status: Active/Off" follows its switch before saving.
		echo '<script>document.addEventListener("change",function(e){var i=e.target;if(!i.matches||!i.matches(".ffc-card-f .ffc-switch input"))return;var b=i.closest(".ffc-card-f").querySelector(".ffc-status b");if(!b)return;b.textContent=i.checked?b.dataset.on:b.dataset.off;b.className=i.checked?"ffc-ok":"ffc-off"});</script>';
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
		$name = $c && ! empty( $c['app_name'] ) ? $c['app_name'] : 'Fullfilio';
		$home = $c && ! empty( $c['app_url'] ) ? $c['app_url'] : 'https://fullfilio.com';
		$t    = self::TABS[ $tab ];

		self::styles();
		echo '<div class="wrap ffc-wrap"><div class="ffc-hero"><div class="ffc-in"><div class="ffc-hero-top"><div>';
		echo '<p class="ffc-eyebrow">' . esc_html( $name ) . ' Connect ' . self::connection_chip( $c ) . '</p>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- connection_chip() escapes.
		echo '<h1>' . esc_html( $t[0] ) . ' <span class="ffc-ver">v' . esc_html( FFC_VERSION ) . '</span></h1>';
		echo '<p class="ffc-sub">' . esc_html( sprintf( $t[2], $name ) ) . '</p></div>';
		echo '<a class="ffc-brand" href="' . esc_url( $home ) . '" target="_blank" rel="noopener" aria-label="' . esc_attr__( 'Open Fullfilio', 'fullfilio-connect' ) . '">' . self::logo() . '</a></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- logo() returns fixed SVG.

		$update = class_exists( 'FFC_Updater' ) && current_user_can( 'update_plugins' ) ? FFC_Updater::available() : null;
		if ( $update ) {
			echo '<div class="ffc-update"><p><strong>Version ' . esc_html( $update['version'] ) . ' is available.</strong> You have ' . esc_html( FFC_VERSION ) . '.</p><div class="ffc-row">'
				. '<a class="ffc-btn primary" href="' . esc_url( FFC_Updater::update_url() ) . '">' . self::icon( 'download' ) . 'Update now</a>' // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
				. '<a class="ffc-btn" href="' . esc_url( self_admin_url( 'plugins.php' ) ) . '">What\'s new</a></div></div>';
		}

		echo '<nav class="ffc-tabs ffc-scroll" aria-label="Fullfilio Connect">';
		foreach ( self::TABS as $key => $tt ) {
			echo '<a class="ffc-tab' . ( $key === $tab ? ' is-on' : '' ) . '" href="' . esc_url( self::url( array( 'tab' => $key ) ) ) . '"' . ( $key === $tab ? ' aria-current="page"' : '' ) . '>' . self::icon( $tt[1] ) . esc_html( $tt[0] ) . '</a>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		}
		echo '</nav></div></div>';

		echo '<div class="ffc-body"><div class="ffc-in">';
		if ( $notice ) {
			echo '<div class="notice notice-' . esc_attr( in_array( $type, array( 'success', 'error', 'warning' ), true ) ? $type : 'info' ) . ' inline" style="margin:0 0 20px"><p>' . esc_html( $notice ) . '</p></div>';
		}
		call_user_func( array( __CLASS__, 'tab_' . $tab ), $c, $name );
		echo '<p class="ffc-foot">' . esc_html( $name ) . ' Connect ' . esc_html( FFC_VERSION ) . ( class_exists( 'FFC_Updater' ) && current_user_can( 'update_plugins' ) ? ' · <a href="' . esc_url( FFC_Updater::check_url() ) . '">Check for updates</a>' : '' ) . '</p>';
		echo '</div></div></div>';
		self::script();
	}

	private static function connection_chip( $c ) {
		$state = FFC_Settings::state();
		if ( ! $c ) {
			return '<span class="ffc-badge ffc-amber">Not connected</span>';
		}
		return empty( $state['last_error'] ) ? '<span class="ffc-badge ffc-green">Connected</span>' : '<span class="ffc-badge ffc-amber" title="' . esc_attr( $state['last_error'] ) . '">Connected · last contact failed</span>';
	}

	private static function connect_steps() {
		echo '<ol style="margin:0 0 14px 18px;line-height:1.7"><li>In Fullfilio open <strong>Sales channels → WooCommerce → Connect</strong>.</li><li>Enter this store\'s address: <code>' . esc_html( home_url() ) . '</code> and approve the access WooCommerce asks for.</li><li>Fullfilio connects this plugin by itself. Nothing to copy.</li></ol>';
		echo '<details><summary>Fullfilio cannot reach this site? Paste the connection code instead</summary><form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:12px">';
		wp_nonce_field( 'ffc_code' );
		echo '<input type="hidden" name="action" value="ffc_code"><textarea name="code" rows="3" placeholder="ffc1.…" required></textarea><p><button class="ffc-btn primary" type="submit">' . self::icon( 'plug' ) . 'Connect with code</button></p></form></details>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	}

	private static function card_open( $title, $icon = '', $right = '' ) {
		echo '<div class="ffc-card"><div class="ffc-card-h"><h2>' . ( $icon ? self::icon( $icon ) : '' ) . esc_html( $title ) . '</h2>' . $right . '</div><div class="ffc-card-b">'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- icon() fixed SVG; $right is built by callers from escaped parts.
	}

	private static function card_close( $footer = '' ) {
		echo '</div>' . ( $footer ? '<div class="ffc-card-f">' . $footer . '</div>' : '' ) . '</div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- built from escaped parts.
	}

	// --- tabs ------------------------------------------------------------------------------------

	private static function tab_overview( $c, $name ) {
		$week    = FFC_Stats::series( 14 );
		$orders  = wp_list_pluck( $week, 'orders' );
		$revenue = wp_list_pluck( $week, 'revenue' );
		$leads   = wp_list_pluck( $week, 'leads' );
		$stopped = array_map( static function ( $d ) { return $d['blocked'] + $d['flagged']; }, $week );
		$cards   = array(
			array( 'Orders · 7 days', FFC_Stats::total( 'orders' ), FFC_Stats::total( 'orders', 7, 7 ), $orders, false ),
			array( 'Order value · 7 days', FFC_Stats::total( 'revenue' ), FFC_Stats::total( 'revenue', 7, 7 ), $revenue, true ),
			array( 'Unfinished checkouts', FFC_Stats::total( 'leads' ), FFC_Stats::total( 'leads', 7, 7 ), $leads, false ),
			array( 'Stopped or flagged', FFC_Stats::total( 'blocked' ) + FFC_Stats::total( 'flagged' ), FFC_Stats::total( 'blocked', 7, 7 ) + FFC_Stats::total( 'flagged', 7, 7 ), $stopped, false ),
		);
		if ( ! $c ) {
			self::card_open( 'Connect this store', 'plug' );
			self::connect_steps();
			self::card_close();
		}
		echo '<div class="ffc-stats">';
		foreach ( $cards as $k ) {
			$chg = self::change( $k[1], $k[2] );
			echo '<div class="ffc-stat"><div><small>' . esc_html( $k[0] ) . '</small><b>' . esc_html( $k[4] ? self::money( $k[1] ) : number_format_i18n( $k[1] ) ) . '</b>' . ( $chg ? '<span class="ffc-chg' . ( '-' === $chg[0] ? ' down' : '' ) . '">' . esc_html( $chg ) . '</span>' : '' ) . '</div>' . self::spark( array_slice( $k[3], -7 ) ) . '</div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- spark() builds numbers only.
		}
		echo '</div><div class="ffc-cols"><div>';

		$max = max( 1, max( $orders ) );
		$top = array_search( max( $orders ), $orders, true );
		self::card_open( 'Orders, last 14 days', 'dashboard', '<span class="ffc-muted" style="font-size:12px">counted since the plugin was installed</span>' );
		echo '<div class="ffc-bars">';
		foreach ( $week as $i => $d ) {
			$h = max( 3, round( $d['orders'] / $max * 100 ) );
			echo '<div class="ffc-bar' . ( $d['orders'] > 0 && $i === $top ? ' top' : '' ) . '" title="' . esc_attr( sprintf( '%s: %d orders · %s', wp_date( 'M j', strtotime( $d['day'] ) ), $d['orders'], self::money( $d['revenue'] ) ) ) . '"><i style="height:' . esc_attr( (string) $h ) . '%"></i><span>' . esc_html( wp_date( 'j', strtotime( $d['day'] ) ) ) . '</span></div>';
		}
		echo '</div>';
		self::card_close();

		self::card_open( 'Recent orders', 'orders', '<a class="ffc-btn sm" href="' . esc_url( self::url( array( 'tab' => 'orders' ) ) ) . '">All orders</a>' );
		self::orders_table( self::recent_orders( 8 ) );
		self::card_close();
		echo '</div><div>';

		$state = FFC_Settings::state();
		self::card_open( $name, 'plug' );
		if ( $c ) {
			echo '<p><span class="ffc-dot' . ( empty( $state['last_error'] ) ? '' : ' warn' ) . '"></span>Connected since ' . esc_html( wp_date( 'M j, Y', strtotime( $c['paired_at'] ) ) ) . '</p><p class="ffc-muted">Last contact ' . esc_html( isset( $state['last_ok_at'] ) ? $state['last_ok_at'] : 'never' ) . '</p><div class="ffc-row">';
			self::button( 'test', 'Test connection', 'ffc-btn primary', 'refresh' );
			if ( $c['app_url'] ) {
				echo '<a class="ffc-btn" href="' . esc_url( $c['app_url'] ) . '" target="_blank" rel="noopener">' . self::icon( 'external' ) . 'Open ' . esc_html( $name ) . '</a>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
			}
			echo '</div>';
		} else {
			echo '<p class="ffc-muted">Not connected yet. Ad tracking and checkout protection work without it.</p>';
		}
		self::card_close();

		$q    = FFC_Outbox::stats();
		$done = $q['sent'] + $q['failed'];
		$pct  = $done > 0 ? round( $q['sent'] / $done * 100, 1 ) : 100;
		self::card_open( 'Delivery to ' . $name, 'send' );
		echo self::gauge( $pct ) . '<div class="ffc-gauge-n">' . esc_html( (string) $pct ) . '%</div><p class="ffc-muted" style="text-align:center">' . esc_html( sprintf( 'delivered · %d waiting · %d failed', $q['pending'] + $q['sending'], $q['failed'] ) ) . '</p>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- gauge() builds numbers only.
		if ( $q['failed'] > 0 ) {
			echo '<div class="ffc-row" style="justify-content:center">';
			self::button( 'retry', 'Send again', 'ffc-btn primary', 'refresh' );
			echo '</div>';
		}
		self::card_close();

		$feed = array();
		foreach ( FFC_Log::recent( 6 ) as $l ) {
			$feed[] = array( 'at' => $l['at'], 'text' => $l['message'] );
		}
		foreach ( FFC_Protect::recent( 4 ) as $p ) {
			$feed[] = array( 'at' => $p['at'] . 'Z', 'text' => ( 'bot_flagged' === $p['kind'] ? 'Flagged ' : 'Stopped ' ) . $p['phone'] . ': ' . $p['why'] );
		}
		foreach ( FFC_Stock::recent( 4 ) as $m ) {
			$feed[] = array( 'at' => $m['at'] . 'Z', 'text' => sprintf( '+%d %s back in stock (#%s)', $m['added'], $m['product'], $m['order'] ) );
		}
		usort( $feed, static function ( $a, $b ) { return strcmp( $b['at'], $a['at'] ); } );
		self::card_open( 'Activity', 'inbox' );
		if ( ! $feed ) {
			echo '<p class="ffc-muted">Nothing yet.</p>';
		} else {
			echo '<ul class="ffc-feed">';
			foreach ( array_slice( $feed, 0, 7 ) as $f ) {
				echo '<li>' . esc_html( $f['text'] ) . '<small>' . esc_html( wp_date( 'M j, H:i', strtotime( $f['at'] ) ) ) . '</small></li>';
			}
			echo '</ul>';
		}
		self::card_close();
		echo '</div></div>';
	}

	private static function tab_orders( $c, $name ) {
		self::card_open( 'Latest orders', 'orders' );
		self::orders_table( self::recent_orders( 25 ) );
		self::card_close();
		self::card_open( 'Statuses ' . $name . ' sets', 'tag' );
		echo '<div class="ffc-row" style="margin-bottom:12px">';
		foreach ( array( 'confirmed', 'shipped', 'delivered', 'partial-delivered', 'returning', 'returned', 'cancelled' ) as $st ) {
			echo self::badge( $st ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- badge() escapes.
		}
		echo '</div><p class="ffc-muted">The WooCommerce order follows the order in ' . esc_html( $name ) . ' from Confirmed on. A status set by ' . esc_html( $name ) . ' is not sent back to it.</p>';
		self::card_close();
	}

	private static function tab_stock( $c, $name ) {
		$st = FFC_Stock::summary();
		echo '<div class="ffc-stats">';
		foreach ( array( array( 'Tracked products', $st['tracked'] ), array( 'Low (≤ ' . $st['threshold'] . ')', $st['low'] ), array( 'Out of stock', $st['out'] ), array( 'Put back · 7 days', array_sum( array_map( static function ( $m ) { return strtotime( $m['at'] . ' UTC' ) > time() - WEEK_IN_SECONDS ? (int) $m['added'] : 0; }, FFC_Stock::recent( 200 ) ) ) ) ) as $k ) {
			echo '<div class="ffc-stat"><div><small>' . esc_html( $k[0] ) . '</small><b>' . esc_html( number_format_i18n( $k[1] ) ) . '</b></div></div>';
		}
		echo '</div>';
		self::card_open( 'Who keeps the count', 'stock' );
		echo '<p>' . ( FFC_Stock::managed_by_fullfilio()
			? '<strong>' . esc_html( $name ) . ' keeps the count.</strong> <span class="ffc-muted">It sends each product\'s stock here. Orders still take stock off at checkout; cancels and returns are counted in ' . esc_html( $name ) . ', so they are not put back here twice.</span>'
			: '<strong>WooCommerce keeps the count.</strong> <span class="ffc-muted">A cancel puts items back the WooCommerce way. Items that come back to ' . esc_html( $name ) . ' (a return, or the undelivered part of a partial delivery) are put back here automatically, once.</span>' ) . '</p>';
		self::card_close();
		if ( $st['low_items'] ) {
			self::card_open( 'Low or out of stock', 'stock' );
			echo '<div class="ffc-scroll"><table class="ffc-tbl"><thead><tr><th>Product</th><th>SKU</th><th>Stock</th></tr></thead><tbody>';
			foreach ( $st['low_items'] as $it ) {
				echo '<tr><td>' . ( $it['edit'] ? '<a href="' . esc_url( $it['edit'] ) . '">' . esc_html( $it['name'] ) . '</a>' : esc_html( $it['name'] ) ) . '</td><td class="ffc-mono">' . esc_html( (string) $it['sku'] ) . '</td><td>' . esc_html( (string) $it['stock'] ) . '</td></tr>';
			}
			echo '</tbody></table></div>';
			self::card_close();
		}
		$moves = FFC_Stock::recent( 15 );
		self::card_open( 'Put back by ' . $name, 'refresh' );
		if ( ! $moves ) {
			echo '<p class="ffc-muted">Nothing yet. Returned items show here when they are put back.</p>';
		} else {
			echo '<div class="ffc-scroll"><table class="ffc-tbl"><thead><tr><th>When (UTC)</th><th>Order</th><th>Product</th><th>Added</th><th>Stock after</th><th>Why</th></tr></thead><tbody>';
			foreach ( $moves as $m ) {
				$order = ! empty( $m['order_id'] ) && function_exists( 'wc_get_order' ) ? wc_get_order( $m['order_id'] ) : null;
				$link  = $order ? $order->get_edit_order_url() : '';
				echo '<tr><td>' . esc_html( $m['at'] ) . '</td><td>' . ( $link ? '<a href="' . esc_url( $link ) . '">#' . esc_html( (string) $m['order'] ) . '</a>' : '#' . esc_html( (string) $m['order'] ) ) . '</td><td>' . esc_html( $m['product'] ) . '</td><td>+' . esc_html( (string) $m['added'] ) . '</td><td>' . esc_html( null === $m['stock'] ? '?' : (string) $m['stock'] ) . '</td><td class="ffc-muted">' . esc_html( $m['reason'] ) . '</td></tr>';
			}
			echo '</tbody></table></div>';
		}
		self::card_close();
	}

	private static function tab_protect( $c, $name ) {
		$s     = FFC_Protect::settings();
		$radio = static function ( $field, $value, $title, $text ) use ( $s ) {
			return '<label><input type="radio" name="' . esc_attr( $field ) . '" value="' . esc_attr( $value ) . '"' . checked( $s[ $field ], $value, false ) . '><b>' . esc_html( $title ) . '</b><span>' . esc_html( $text ) . '</span></label>';
		};
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( 'ffc_protect_save' );
		echo '<input type="hidden" name="action" value="ffc_protect_save"><div class="ffc-mods">';

		echo '<div class="ffc-card"><div class="ffc-card-h"><h2><span class="ffc-mod-ic" style="background:#2563eb">' . self::icon( 'phone' ) . '</span>Phone number check</h2></div><div class="ffc-card-b"><p class="ffc-desc">Checked on the server when the order is placed (it cannot be skipped from the browser). The order keeps the clean 01XXXXXXXXX number.</p><div class="ffc-choice">' // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
			. $radio( 'phone_mode', 'off', 'Off', 'Any number is accepted.' )
			. $radio( 'phone_mode', 'normal', 'Normal', 'Only Bangladeshi mobile numbers (01[3-9] + 8 digits; +880 is fine).' )
			. $radio( 'phone_mode', 'strict', 'Strict', 'Also refuses made-up numbers like 01711111111.' )
			. '</div></div><div class="ffc-card-f">' . self::status_text( 'off' !== $s['phone_mode'] ) . '</div></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $radio and status_text() escape.

		echo '<div class="ffc-card"><div class="ffc-card-h"><h2><span class="ffc-mod-ic" style="background:#7c3aed">' . self::icon( 'bot' ) . '</span>Bots and fake orders</h2></div><div class="ffc-card-b"><p class="ffc-desc">Looks for no typing or tapping, an order sent within seconds, a script instead of a browser, a hidden field filled in, and many orders from one IP.</p><div class="ffc-choice">' // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
			. $radio( 'bot_mode', 'off', 'Off', 'No bot check.' )
			. $radio( 'bot_mode', 'flag', 'Flag only', 'The order goes through with a risk note.' )
			. $radio( 'bot_mode', 'block', 'Block', 'High-risk checkouts are refused politely.' )
			. '</div><div class="ffc-row" style="margin-top:16px;gap:24px"><div class="ffc-field" style="margin:0"><label for="ffc-min">Seconds a person needs at least</label><input id="ffc-min" class="ffc-num" type="number" min="0" max="60" name="min_seconds" value="' . esc_attr( (string) $s['min_seconds'] ) . '"><small>from opening the checkout to placing the order (0 = no limit)</small></div>'
			. '<div class="ffc-field" style="margin:0"><label for="ffc-ip">Orders per IP per hour</label><input id="ffc-ip" class="ffc-num" type="number" min="1" max="50" name="ip_hourly" value="' . esc_attr( (string) $s['ip_hourly'] ) . '"><small>more than this counts as a risk</small></div></div>'
			. '</div><div class="ffc-card-f">' . self::status_text( 'off' !== $s['bot_mode'] ) . '</div></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped

		echo '<div class="ffc-card"><div class="ffc-card-h"><h2><span class="ffc-mod-ic" style="background:#f38020">' . self::icon( 'cloud' ) . '</span>Cloudflare Turnstile</h2></div><div class="ffc-card-b"><p class="ffc-desc">A free, invisible human check from Cloudflare on the classic checkout. Create a widget at dash.cloudflare.com → Turnstile and paste its keys.</p>' // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
			. '<div class="ffc-field"><label for="ffc-ts">Site key</label><input id="ffc-ts" type="text" name="turnstile_site" value="' . esc_attr( $s['turnstile_site'] ) . '"></div>'
			. '<div class="ffc-field"><label for="ffc-tss">Secret key</label><input id="ffc-tss" type="password" name="turnstile_secret" autocomplete="new-password" placeholder="' . esc_attr( $s['turnstile_secret'] ? 'Saved — leave empty to keep it' : 'Secret key' ) . '">'
			. ( $s['turnstile_secret'] ? '<label class="ffc-check"><input type="checkbox" name="turnstile_clear" value="1"> Remove the keys</label>' : '' ) . '</div>'
			. '</div><div class="ffc-card-f">' . self::status_text( FFC_Protect::turnstile_on() ) . '</div></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped

		echo '</div><p><button class="ffc-btn primary" type="submit">' . self::icon( 'check' ) . 'Save protection</button></p></form>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped

		$log = FFC_Protect::recent( 25 );
		self::card_open( 'Stopped or flagged', 'shield' );
		if ( ! $log ) {
			echo '<p class="ffc-muted">Nothing stopped or flagged yet.</p>';
		} else {
			echo '<div class="ffc-scroll"><table class="ffc-tbl"><thead><tr><th>When (UTC)</th><th>What</th><th>Phone</th><th>Risk</th><th>Why</th></tr></thead><tbody>';
			$what = array( 'phone' => array( 'Wrong number', 'red' ), 'bot_blocked' => array( 'Blocked', 'red' ), 'bot_flagged' => array( 'Flagged', 'amber' ) );
			foreach ( $log as $l ) {
				$w = isset( $what[ $l['kind'] ] ) ? $what[ $l['kind'] ] : array( $l['kind'], 'gray' );
				echo '<tr><td>' . esc_html( $l['at'] ) . '</td><td><span class="ffc-badge ffc-' . esc_attr( $w[1] ) . '">' . esc_html( $w[0] ) . '</span></td><td class="ffc-mono">' . esc_html( $l['phone'] ) . '</td><td>' . esc_html( null === $l['score'] ? '—' : (string) $l['score'] ) . '</td><td class="ffc-muted">' . esc_html( $l['why'] ) . '</td></tr>';
			}
			echo '</tbody></table></div>';
		}
		self::card_close();
	}

	/** Footer for one ad platform: status, last connection result, switch. */
	private static function platform_footer( $platform, $on ) {
		$st    = FFC_Tracking::status( $platform );
		$extra = '';
		if ( $st ) {
			if ( $st['ok'] ) {
				$extra = ' <span class="ffc-badge ffc-green" title="' . esc_attr( 'Last check ' . $st['at'] . ' UTC' ) . '">' . self::icon( 'check' ) . 'Connected</span>';
			} elseif ( 'hint' === $st['kind'] ) {
				$extra = ' <span class="ffc-badge ffc-amber" title="' . esc_attr( $st['message'] ) . '">Not checked yet</span>';
			} else {
				$extra = ' <span class="ffc-badge ffc-red" title="' . esc_attr( $st['message'] . ' (' . $st['at'] . ' UTC)' ) . '">Problem: ' . esc_html( wp_html_excerpt( $st['message'], 60, '…' ) ) . '</span>';
			}
		}
		return self::status_text( $on, $extra ) . self::switch_input( $platform . '_on', $on );
	}

	private static function tab_tracking( $c, $name ) {
		$s   = FFC_Tracking::settings();
		$tok = static function ( $field, $has, $label ) {
			return '<input type="password" name="' . esc_attr( $field ) . '" autocomplete="new-password" placeholder="' . esc_attr( $has ? 'Saved — leave empty to keep it' : $label ) . '">'
				. ( $has ? '<label class="ffc-check"><input type="checkbox" name="' . esc_attr( $field ) . '_clear" value="1"> Remove</label>' : '' );
		};
		$field = static function ( $label, $input, $hint = '' ) {
			return '<div class="ffc-field"><label>' . esc_html( $label ) . '</label>' . $input . ( $hint ? '<small>' . esc_html( $hint ) . '</small>' : '' ) . '</div>';
		};
		$test = static function ( $platform ) {
			return '<button type="submit" class="ffc-btn" name="ffc_test" value="' . esc_attr( $platform ) . '">' . self::icon( 'refresh' ) . 'Save &amp; test connection</button>';
		};

		// Match quality (our estimate from the keys actually sent).
		$mq     = FFC_Tracking::match_summary();
		$labels = array(
			'em' => 'Email', 'ph' => 'Phone', 'fbc' => 'Click id (fbc)', 'external_id' => 'Visitor id', 'fbp' => 'Browser id (fbp)',
			'client_ip_address' => 'IP address', 'client_user_agent' => 'Browser', 'fn' => 'First name', 'ln' => 'Last name',
			'ct' => 'City', 'st' => 'District', 'zp' => 'Postcode', 'country' => 'Country',
		);
		self::card_open( 'Match quality', 'target', '<span class="ffc-badge ffc-blue">Meta · estimate</span>' );
		echo '<div class="ffc-mq"><div><div class="ffc-mq-n">' . esc_html( $mq ? number_format_i18n( $mq['score'], 1 ) : '—' ) . ' <small>/ 10</small></div><div class="ffc-meter"><i style="width:' . esc_attr( (string) ( $mq ? $mq['score'] * 10 : 0 ) ) . '%"></i></div><small class="ffc-hint">' . esc_html( $mq ? sprintf( 'From the last %d purchases sent', $mq['orders'] ) : 'Shows after the first purchase is sent' ) . '</small></div><div><div class="ffc-keys">';
		foreach ( $labels as $k => $l ) {
			$pct = $mq ? (int) $mq['coverage'][ $k ] : null;
			$cls = null === $pct ? '' : ( $pct >= 80 ? ' full' : ( $pct > 0 ? ' part' : '' ) );
			echo '<span class="ffc-key' . esc_attr( $cls ) . '"><i></i>' . esc_html( $l ) . ( null === $pct ? '' : ' <em>' . esc_html( $pct . '%' ) . '</em>' ) . '</span>';
		}
		echo '</div><p class="ffc-hint" style="margin:12px 0 0">Every purchase carries all of these when the store has them, hashed. Meta shows its own Event Match Quality in Events Manager → your pixel → Overview; email is the biggest gap for most cash-on-delivery stores — an optional email field at checkout lifts the score above 8.</p></div></div>';
		self::card_close();

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( 'ffc_tracking_save' );
		echo '<input type="hidden" name="action" value="ffc_tracking_save"><div class="ffc-mods">';

		// Meta
		echo '<div class="ffc-card"><div class="ffc-card-h"><h2><span class="ffc-mod-ic" style="background:#1877f2">f</span>Meta — Pixel + Conversions API</h2></div><div class="ffc-card-b">'
			. '<p class="ffc-desc">Facebook and Instagram. The browser Pixel and the Conversions API send every event with one event id, so Meta counts it once.</p>'
			. $field( 'Pixel ID (dataset ID)', '<input type="text" name="meta_pixel" value="' . esc_attr( $s['meta']['pixel'] ) . '" placeholder="123456789012345">' )
			. $field( 'Conversions API access token', $tok( 'meta_token', ! empty( $s['meta']['token'] ), 'Access token' ), 'Events Manager → your pixel → Settings → Conversions API → Generate access token.' )
			. $field( 'Test event code (optional)', '<input type="text" name="meta_test" value="' . esc_attr( $s['meta']['test'] ) . '" placeholder="TEST12345">', 'Events Manager → Test events. Leave empty for live.' )
			. $test( 'meta' ) . '</div><div class="ffc-card-f">' . self::platform_footer( 'meta', $s['meta']['on'] ) . '</div></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- built from escaped parts.

		// TikTok
		echo '<div class="ffc-card"><div class="ffc-card-h"><h2><span class="ffc-mod-ic" style="background:#000">' . self::icon( 'megaphone' ) . '</span>TikTok — Pixel + Events API</h2></div><div class="ffc-card-b">'
			. '<p class="ffc-desc">The browser Pixel and the Events API with the ttclid click id and the _ttp cookie; CompletePayment when the order counts.</p>'
			. $field( 'Pixel ID', '<input type="text" name="tiktok_pixel" value="' . esc_attr( $s['tiktok']['pixel'] ) . '" placeholder="CXXXXXXXXXXXXXXXXXXX">' )
			. $field( 'Events API access token', $tok( 'tiktok_token', ! empty( $s['tiktok']['token'] ), 'Access token' ), 'Events Manager → your pixel → Settings → Generate access token.' )
			. $field( 'Test event code', '<input type="text" name="tiktok_test" value="' . esc_attr( $s['tiktok']['test'] ) . '" placeholder="TEST12345">', 'Needed for the connection test. Remove it to go live.' )
			. $test( 'tiktok' ) . '</div><div class="ffc-card-f">' . self::platform_footer( 'tiktok', $s['tiktok']['on'] ) . '</div></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped

		// Google
		echo '<div class="ffc-card"><div class="ffc-card-h"><h2><span class="ffc-mod-ic" style="background:#fff;border:1px solid #dcdcde;color:#4285f4">G</span>Google — Ads + GA4 (Enhanced Conversions)</h2></div><div class="ffc-card-b">'
			. '<p class="ffc-desc">gtag in the browser and the GA4 Measurement Protocol from the server with hashed email, phone and address; the purchase imports into Google Ads.</p>'
			. $field( 'Google Ads conversion ID', '<input type="text" name="google_conv_id" value="' . esc_attr( $s['google']['conv_id'] ) . '" placeholder="AW-123456789">' )
			. $field( 'Conversion label', '<input type="text" name="google_conv_label" value="' . esc_attr( $s['google']['conv_label'] ) . '" placeholder="abcDEF123">' )
			. $field( 'GA4 Measurement ID', '<input type="text" name="google_ga4_id" value="' . esc_attr( $s['google']['ga4_id'] ) . '" placeholder="G-XXXXXXX">' )
			. $field( 'GA4 Measurement Protocol API secret', $tok( 'google_ga4_secret', ! empty( $s['google']['ga4_secret'] ), 'API secret' ), 'GA4 → Admin → Data streams → your stream → Measurement Protocol API secrets.' )
			. $test( 'google' ) . '</div><div class="ffc-card-f">' . self::platform_footer( 'google', $s['google']['on'] ) . '</div></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped

		// Sending rules (fourth tile spans the grid on narrow screens).
		$opt = static function ( $field, $on, $title, $text, $more = '' ) {
			return '<div class="ffc-opt"><div><b>' . esc_html( $title ) . '</b><p>' . esc_html( $text ) . '</p>' . $more . '</div><label class="ffc-switch sm"><input type="checkbox" name="' . esc_attr( $field ) . '" value="1"' . checked( $on, true, false ) . ' aria-label="' . esc_attr( $title ) . '"><span></span></label></div>';
		};
		echo '<div class="ffc-card"><div class="ffc-card-h"><h2><span class="ffc-mod-ic" style="background:#0f766e">' . self::icon( 'shield' ) . '</span>Which orders count</h2></div><div class="ffc-card-b">' // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
			. $opt( 'exclude_low_rr', $s['exclude_low_rr'], 'Skip low-receive-rate customers', 'A customer whose courier receive rate is below the limit is not counted. ' . $name . ' sends the rate when it confirms; a shield "advance" or "block" counts as low.', '<div class="ffc-row"><input class="ffc-num" type="number" min="0" max="100" name="min_rr" value="' . esc_attr( (string) $s['min_rr'] ) . '" aria-label="Lowest receive rate"><span class="ffc-muted">% lowest receive rate</span></div>' )
			. $opt( 'skip_duplicates', $s['skip_duplicates'], 'Skip duplicate orders', 'The same customer (phone, else email) ordering again soon is counted once — like a double-tapped checkout or a re-order after a call.', '<div class="ffc-row"><input class="ffc-num" type="number" min="1" max="168" name="dup_hours" value="' . esc_attr( (string) $s['dup_hours'] ) . '" aria-label="Hours"><span class="ffc-muted">hours</span></div>' )
			. '</div></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo '</div>'; // /ffc-mods

		self::card_open( 'Sending rules', 'send' );
		$choice = static function ( $value, $title, $text, $tag = '' ) use ( $s ) {
			return '<label><input type="radio" name="trigger" value="' . esc_attr( $value ) . '"' . checked( $s['trigger'], $value, false ) . '><b>' . esc_html( $title ) . ( $tag ? ' <span class="ffc-badge ffc-blue">' . esc_html( $tag ) . '</span>' : '' ) . '</b><span>' . esc_html( $text ) . '</span></label>';
		};
		echo '<p class="ffc-section" style="margin-top:0">When the Purchase counts</p><div class="ffc-choice">'
			. $choice( 'placed', 'When the order is placed', 'The normal way: every new order goes to your pixels at once (browser and server, one event id). Learns fastest, but also counts orders that are later cancelled.' )
			. $choice( 'confirmed', 'On call confirmation', 'Held until your team confirms the order on the phone (status Confirmed). The ad platforms learn from real buyers.', 'Recommended' )
			. $choice( 'delivered', 'On delivery', 'Held until the parcel is delivered. The purest signal, but slower to arrive.' )
			. '</div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo '<p class="ffc-section">Browser and server</p>'
			. $opt( 'browser_events', $s['browser_events'], 'Browser pixel events', 'PageView, ViewContent, AddToCart and InitiateCheckout from the shopper\'s browser.' )
			. $opt( 'server_events', $s['server_events'], 'Server events (Conversions API / Events API)', 'The same events from your server with the same event id — ad blockers and iOS lose nothing and nothing is counted twice. Works with page caching.' )
			. $opt( 'advanced_matching', $s['advanced_matching'], 'Advanced matching in the browser', 'Hashed email, phone, name and address for signed-in customers and on the buyer\'s own thank-you page, plus a first-party visitor id on every page.' )
			. $opt( 'browser_purchase', $s['browser_purchase'], 'Also fire Purchase in the browser on the thank-you page', 'For "On call confirmation" and "On delivery" only — it counts the order before it is confirmed. "When the order is placed" always fires it (de-duplicated).' ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo '<p style="margin:18px 0 0"><button class="ffc-btn primary" type="submit">' . self::icon( 'check' ) . 'Save ad tracking</button></p>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		self::card_close();
		echo '</form>';

		// Recent purchases: sent or not counted, and why.
		$rows = FFC_Tracking::recent( 25 );
		self::card_open( 'Recent purchases', 'inbox' );
		if ( ! $rows ) {
			echo '<p class="ffc-muted">Nothing yet. Each order shows here when it is sent to your pixels — or held, and why.</p>';
		} else {
			echo '<div class="ffc-scroll"><table class="ffc-tbl"><thead><tr><th>When (UTC)</th><th>Order</th><th>Result</th><th>Match (est.)</th></tr></thead><tbody>';
			foreach ( $rows as $r ) {
				if ( ! empty( $r['skipped'] ) ) {
					$result = '<span class="ffc-badge ffc-amber">Not counted</span> <span class="ffc-muted">' . esc_html( $r['skipped'] ) . '</span>';
				} else {
					$result = ( $r['sent'] ? '<span class="ffc-badge ffc-green">Sent to ' . esc_html( implode( ', ', $r['sent'] ) ) . '</span>' : '' )
						. ( $r['errors'] ? ' <span class="ffc-badge ffc-red" title="' . esc_attr( implode( ' | ', $r['errors'] ) ) . '">' . esc_html( wp_html_excerpt( implode( ' | ', $r['errors'] ), 70, '…' ) ) . '</span>' : '' );
				}
				$mqv = ! empty( $r['mq'] ) && is_array( $r['mq'] ) ? number_format_i18n( (float) $r['mq']['score'], 1 ) : '—';
				echo '<tr><td>' . esc_html( $r['at'] ) . '</td><td>#' . esc_html( $r['order'] ) . '</td><td>' . $result . '</td><td>' . esc_html( $mqv ) . '</td></tr>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $result is built from escaped parts.
			}
			echo '</tbody></table></div>';
		}
		self::card_close();
	}

	private static function tab_connect( $c, $name ) {
		$state = FFC_Settings::state();
		$cfg   = FFC_Settings::config();
		self::card_open( 'Connection', 'plug', self::connection_chip( $c ) );
		if ( $c ) {
			echo '<p><span class="ffc-dot' . ( empty( $state['last_error'] ) ? '' : ' warn' ) . '"></span>Connected to <strong>' . esc_html( $c['app_name'] ) . '</strong>' . ( $c['app_url'] ? ' (<a href="' . esc_url( $c['app_url'] ) . '" target="_blank" rel="noopener">open</a>)' : '' ) . ' since ' . esc_html( $c['paired_at'] ) . '.</p>';
			echo '<p class="ffc-muted">Store id ' . esc_html( $c['channel_id'] ) . ' · last contact ' . esc_html( isset( $state['last_ok_at'] ) ? $state['last_ok_at'] : 'never' ) . ( ! empty( $state['last_error'] ) ? ' · last problem: ' . esc_html( $state['last_error'] ) : '' ) . '</p><div class="ffc-row">';
			self::button( 'test', 'Test connection', 'ffc-btn primary', 'refresh' );
			self::button( 'disconnect', 'Disconnect', 'ffc-btn danger', 'power' );
			echo '</div>';
		} else {
			self::connect_steps();
		}
		self::card_close();

		$mods = array(
			'order_events'    => array( 'Instant orders', 'inbox', '#2563eb', 'New orders and status changes are queued for ' . $name . ' the moment they happen, and retried until they arrive.' ),
			'capture_leads'   => array( 'Unfinished checkouts', 'cart', '#7c3aed', 'Phone, name, address and cart from checkouts that were not completed, so your team can call back.' ),
			'attribution'     => array( 'Ad attribution', 'megaphone', '#db2777', 'UTM tags, click ids and ad cookies saved on each order.' ),
			'shield'          => array( 'Order shield', 'shield', '#0f766e', 'Block-listed numbers are stopped; low delivery success asks for an advance instead of cash on delivery.' ),
			'custom_statuses' => array( 'Order statuses', 'tag', '#ea580c', 'Confirmed, Shipped, Delivered, Partially delivered, Return in transit and Returned follow the order in ' . $name . '.' ),
			'stock_sync'      => array( $name . ' keeps the stock', 'stock', '#0891b2', $name . ' sends the stock count; WooCommerce does not put stock back on a cancel (no double count).' ),
		);
		echo '<p class="ffc-section">What this store shares <span style="text-transform:none;letter-spacing:0;font-weight:400">— switched in ' . esc_html( $name ) . ' (the store\'s page); changes arrive with the next contact</span></p><div class="ffc-mods">';
		foreach ( $mods as $key => $m ) {
			$on = ! empty( $cfg[ $key ] ) && ( $c || 'custom_statuses' === $key );
			echo '<div class="ffc-card"><div class="ffc-card-h"><h2><span class="ffc-mod-ic" style="background:' . esc_attr( $m[2] ) . '">' . self::icon( $m[1] ) . '</span>' . esc_html( $m[0] ) . '</h2></div><div class="ffc-card-b"><p class="ffc-desc">' . esc_html( $m[3] ) . '</p></div><div class="ffc-card-f">' . self::status_text( $on ) . self::switch_input( 'ro_' . $key, $on, true ) . '</div></div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- icon() fixed SVG; status_text()/switch_input() escape.
		}
		echo '</div>';
	}

	private static function tab_logs( $c, $name ) {
		self::card_open( 'Troubleshooting', 'help' );
		echo '<div class="ffc-scroll"><table class="ffc-tbl"><tbody>';
		foreach ( FFC_Health::checks() as $check ) {
			echo '<tr><td style="width:20px"><span class="ffc-dot' . ( 'ok' === $check['status'] ? '' : ( 'fail' === $check['status'] ? ' fail' : ' warn' ) ) . '"></span></td><td><strong>' . esc_html( $check['label'] ) . '</strong></td><td class="ffc-muted">' . esc_html( $check['detail'] ) . '</td></tr>';
		}
		echo '</tbody></table></div>';
		self::card_close();

		$stats = FFC_Outbox::stats();
		self::card_open( 'Delivery queue', 'send' );
		echo '<p>' . esc_html( sprintf( '%d waiting · %d failed · %d sent in the last week', $stats['pending'] + $stats['sending'], $stats['failed'], $stats['sent'] ) ) . '</p>';
		if ( $stats['failed'] > 0 ) {
			self::button( 'retry', 'Send again', 'ffc-btn primary', 'refresh' );
		}
		$rows = FFC_Outbox::recent( 15 );
		if ( $rows ) {
			echo '<div class="ffc-scroll"><table class="ffc-tbl" style="margin-top:8px"><thead><tr><th>Event</th><th>Status</th><th>Tries</th><th>Created (UTC)</th><th>Problem</th></tr></thead><tbody>';
			foreach ( $rows as $r ) {
				echo '<tr><td>' . esc_html( $r['type'] ) . '</td><td>' . esc_html( $r['status'] ) . '</td><td>' . esc_html( $r['attempts'] ) . '</td><td>' . esc_html( $r['created_at'] ) . '</td><td class="ffc-muted">' . esc_html( (string) $r['last_error'] ) . '</td></tr>';
			}
			echo '</tbody></table></div>';
		}
		self::card_close();

		$log = FFC_Log::recent( 40 );
		self::card_open( 'Debug log', 'orders' );
		if ( ! $log ) {
			echo '<p class="ffc-muted">Nothing logged yet.</p>';
		} else {
			echo '<div class="ffc-scroll"><table class="ffc-tbl"><tbody>';
			foreach ( $log as $line ) {
				echo '<tr><td style="white-space:nowrap">' . esc_html( $line['at'] ) . '</td><td>' . esc_html( $line['level'] ) . '</td><td>' . esc_html( $line['message'] ) . ( $line['context'] ? ' <span class="ffc-muted">' . esc_html( wp_json_encode( $line['context'] ) ) . '</span>' : '' ) . '</td></tr>';
			}
			echo '</tbody></table></div><p style="margin-top:12px">';
			self::button( 'clear_log', 'Clear log', 'ffc-btn danger', 'trash' );
			echo '</p>';
		}
		self::card_close();
	}
}
