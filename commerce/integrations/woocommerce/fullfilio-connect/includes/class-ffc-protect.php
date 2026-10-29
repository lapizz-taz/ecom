<?php
/**
 * Checkout protection, decided on the server (the browser only helps):
 *
 * 1. Phone check. A Bangladeshi mobile number is required: 01[3-9] and 8 more
 *    digits; +880 / 880 / 0088 / +88 prefixes, spaces, the 0 left off, Bangla
 *    digits and two numbers in one field are accepted, and the order keeps the
 *    clean 01XXXXXXXXX form. Strict also refuses made-up numbers
 *    (01711111111, 01712345678).
 * 2. Bot check. Signals: no typing, tapping or clicking on the checkout page,
 *    the order sent within a few seconds of opening the checkout, a filled
 *    hidden field, a script's user agent, many orders from one IP in an hour,
 *    and Cloudflare Turnstile when the owner adds its keys. "Flag" lets the
 *    order through and marks it (order note + meta); "Block" refuses it when
 *    the risk is high enough.
 *
 * These settings belong to the store, so they are changed on the plugin page.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Protect {
	const OPTION    = 'ffc_protect';
	const LOG       = 'ffc_protect_log';
	const LOG_MAX   = 100;
	const BLOCK_AT  = 60;
	const BOT_UA    = '/(curl|wget|python-requests|python-urllib|httpclient|okhttp|go-http-client|libwww|scrapy|headless|phantomjs|selenium|puppeteer|playwright|bot\b|spider|crawler)/i';
	const TURNSTILE = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

	public static function defaults() {
		return array(
			'phone_mode'       => 'off',   // off | normal | strict
			'bot_mode'         => 'off',   // off | flag | block
			'min_seconds'      => 4,
			'ip_hourly'        => 3,
			'turnstile_site'   => '',
			'turnstile_secret' => '',
		);
	}

	public static function settings() {
		$saved = get_option( self::OPTION, array() );
		return array_merge( self::defaults(), is_array( $saved ) ? $saved : array() );
	}

	/** Keeps only known values; an empty secret field keeps the saved secret. */
	public static function save( $input ) {
		$old = self::settings();
		$new = array(
			'phone_mode'       => in_array( $input['phone_mode'] ?? '', array( 'off', 'normal', 'strict' ), true ) ? $input['phone_mode'] : 'off',
			'bot_mode'         => in_array( $input['bot_mode'] ?? '', array( 'off', 'flag', 'block' ), true ) ? $input['bot_mode'] : 'off',
			'min_seconds'      => max( 0, min( 60, (int) ( $input['min_seconds'] ?? 4 ) ) ),
			'ip_hourly'        => max( 1, min( 50, (int) ( $input['ip_hourly'] ?? 3 ) ) ),
			'turnstile_site'   => preg_match( '/^[0-9A-Za-z_-]{8,100}$/', (string) ( $input['turnstile_site'] ?? '' ) ) ? $input['turnstile_site'] : '',
			'turnstile_secret' => $old['turnstile_secret'],
		);
		$secret = trim( (string) ( $input['turnstile_secret'] ?? '' ) );
		if ( '' !== $secret ) {
			$new['turnstile_secret'] = preg_match( '/^[0-9A-Za-z_.-]{8,200}$/', $secret ) ? $secret : $old['turnstile_secret'];
		}
		if ( ! empty( $input['turnstile_clear'] ) ) {
			$new['turnstile_site']   = '';
			$new['turnstile_secret'] = '';
		}
		update_option( self::OPTION, $new, false );
		return $new;
	}

	public static function turnstile_on() {
		$s = self::settings();
		return 'off' !== $s['bot_mode'] && '' !== $s['turnstile_site'] && '' !== $s['turnstile_secret'];
	}

	public static function init() {
		add_action( 'wp', array( __CLASS__, 'checkout_opened' ) );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'assets' ) );
		add_action( 'wc_ajax_ffc_human', array( __CLASS__, 'human' ) );
		add_action( 'woocommerce_after_order_notes', array( __CLASS__, 'honeypot' ) );
		add_action( 'woocommerce_review_order_before_submit', array( __CLASS__, 'turnstile_widget' ) );
		// Before the order shield (priority 20): a bad number or a bot is refused without asking Fullfilio.
		add_action( 'woocommerce_after_checkout_validation', array( __CLASS__, 'check_classic' ), 10, 2 );
		add_action( 'woocommerce_store_api_checkout_update_order_from_request', array( __CLASS__, 'check_blocks' ), 10, 2 );
		add_action( 'woocommerce_checkout_order_created', array( __CLASS__, 'order_created' ), 5 );
	}

	// --- phone ---------------------------------------------------------------------------------

	/** Bangla digits as 0-9 (customers often type their number on a Bangla keyboard). */
	const BANGLA_DIGITS = array( '০' => '0', '১' => '1', '২' => '2', '৩' => '3', '৪' => '4', '৫' => '5', '৬' => '6', '৭' => '7', '৮' => '8', '৯' => '9' );

	/**
	 * The number as 01XXXXXXXXX, or null when it is not a Bangladeshi mobile number. The same rules as
	 * Fullfilio itself: +880 / 880 / 0088 / +88 in front, an extra 0 after the code (+880 01712…), the 0
	 * left off (1712345678), Bangla digits, and the first of two numbers typed in one field.
	 */
	public static function normalize_phone( $phone ) {
		$text = strtr( (string) $phone, self::BANGLA_DIGITS );
		$d    = self::local_digits( preg_replace( '/\D/', '', $text ) );
		if ( preg_match( '/^01[3-9]\d{8}$/', $d ) ) {
			return $d;
		}
		if ( preg_match( '/(?:^|[^0-9+])(\+?(?:00)?(?:88)?[ -]?0?1[3-9](?:[ -]?[0-9]){8})(?:[^0-9]|$)/', $text, $m ) ) {
			$first = self::local_digits( preg_replace( '/\D/', '', $m[1] ) );
			if ( preg_match( '/^01[3-9]\d{8}$/', $first ) ) {
				return $first;
			}
		}
		return null;
	}

	/** Digits in the local form: 0, then the national number. */
	private static function local_digits( $d ) {
		if ( 0 === strpos( $d, '00880' ) ) {
			return '0' . ltrim( substr( $d, 5 ), '0' );
		}
		if ( 0 === strpos( $d, '880' ) && strlen( $d ) > 11 ) {
			return '0' . ltrim( substr( $d, 3 ), '0' );
		}
		if ( preg_match( '/^881[3-9]\d{8}$/', $d ) ) {
			return '0' . substr( $d, 2 );
		}
		if ( preg_match( '/^0*1[3-9]\d{8}$/', $d ) ) {
			return '0' . ltrim( $d, '0' );
		}
		return $d;
	}

	/** Made-up numbers: the last 8 digits all the same, or counting up or down (12345678, 87654321). */
	public static function looks_fake( $normalized ) {
		$tail = substr( $normalized, 3 );
		if ( preg_match( '/^(\d)\1{7}$/', $tail ) ) {
			return true;
		}
		$up = $down = true;
		for ( $i = 1; $i < 8; $i++ ) {
			$diff = (int) $tail[ $i ] - (int) $tail[ $i - 1 ];
			$up   = $up && ( 1 === $diff || -9 === $diff );
			$down = $down && ( -1 === $diff || 9 === $diff );
		}
		return $up || $down;
	}

	/** @return string|null Error message, or null when the number is fine (or the check is off). */
	public static function phone_error( $phone ) {
		$mode = self::settings()['phone_mode'];
		if ( 'off' === $mode ) {
			return null;
		}
		$n = self::normalize_phone( $phone );
		if ( null === $n ) {
			return __( 'Please enter a valid Bangladeshi mobile number, for example 01712345678.', 'fullfilio-connect' );
		}
		if ( 'strict' === $mode && self::looks_fake( $n ) ) {
			return __( 'This mobile number does not look real. Please enter the number we can call to confirm your order.', 'fullfilio-connect' );
		}
		return null;
	}

	// --- bot signals -----------------------------------------------------------------------------

	/** The helper script on the checkout page only. */
	public static function assets() {
		$s = self::settings();
		if ( ( 'off' === $s['bot_mode'] && 'off' === $s['phone_mode'] ) || is_admin() || ! function_exists( 'is_checkout' ) || ! is_checkout() ) {
			return;
		}
		wp_enqueue_script( 'ffc-protect', FFC_URL . 'assets/ffc-protect.js', array(), FFC_VERSION, true );
		wp_localize_script(
			'ffc-protect',
			'ffcProtect',
			array(
				'humanUrl'     => 'off' !== $s['bot_mode'] && class_exists( 'WC_AJAX' ) ? WC_AJAX::get_endpoint( 'ffc_human' ) : '',
				'phoneCheck'   => 'off' !== $s['phone_mode'],
				'phoneMessage' => __( 'Please enter a valid Bangladeshi mobile number, for example 01712345678.', 'fullfilio-connect' ),
			)
		);
	}

	/** Notes when this visitor first opened the checkout (session). */
	public static function checkout_opened() {
		if ( 'off' === self::settings()['bot_mode'] || is_admin() || ! function_exists( 'is_checkout' ) || ! is_checkout() ) {
			return;
		}
		if ( function_exists( 'is_order_received_page' ) && is_order_received_page() ) {
			return;
		}
		if ( function_exists( 'WC' ) && WC()->session && ! WC()->session->get( 'ffc_opened_at' ) ) {
			WC()->session->set( 'ffc_opened_at', time() );
		}
	}

	/** The browser saw a real person (typing, tapping, clicking or scrolling) on the checkout. */
	public static function human() {
		if ( function_exists( 'WC' ) && WC()->session ) {
			WC()->session->set( 'ffc_human', 1 );
			if ( ! WC()->session->get( 'ffc_opened_at' ) ) {
				WC()->session->set( 'ffc_opened_at', time() );
			}
		}
		wp_send_json( array( 'ok' => true ) );
	}

	/** Hidden field people never see; scripts that fill every field fill it too. */
	public static function honeypot() {
		if ( 'off' === self::settings()['bot_mode'] ) {
			return;
		}
		echo '<div style="position:absolute;left:-9999px" aria-hidden="true"><label for="ffc_website">Website</label><input type="text" id="ffc_website" name="ffc_website" tabindex="-1" autocomplete="off" value=""></div>';
	}

	public static function turnstile_widget() {
		if ( ! self::turnstile_on() ) {
			return;
		}
		wp_enqueue_script( 'ffc-turnstile', 'https://challenges.cloudflare.com/turnstile/v0/api.js', array(), null, true ); // phpcs:ignore WordPress.WP.EnqueuedResourceParameters.MissingVersion -- Cloudflare serves the current version.
		echo '<div class="cf-turnstile" data-sitekey="' . esc_attr( self::settings()['turnstile_site'] ) . '" style="margin:12px 0"></div>';
	}

	/** Cloudflare's answer for the widget token: true, false, or null when Cloudflare could not be asked. */
	private static function turnstile_ok( $token, $ip ) {
		if ( '' === $token ) {
			return false;
		}
		$r = wp_remote_post( self::TURNSTILE, array( 'timeout' => 5, 'body' => array( 'secret' => self::settings()['turnstile_secret'], 'response' => $token, 'remoteip' => $ip ) ) );
		if ( is_wp_error( $r ) || 200 !== wp_remote_retrieve_response_code( $r ) ) {
			FFC_Log::warning( 'Turnstile could not be checked: ' . ( is_wp_error( $r ) ? $r->get_error_message() : 'HTTP ' . wp_remote_retrieve_response_code( $r ) ) . ' (not counted)' );
			return null;
		}
		$body = json_decode( wp_remote_retrieve_body( $r ), true );
		return ! empty( $body['success'] );
	}

	/**
	 * Risk for this checkout, 0–100, with the reasons in plain words.
	 *
	 * @param array $input honeypot?, turnstile?, classic (bool)
	 * @return array{score:int,reasons:string[]}
	 */
	public static function risk( $input ) {
		$s       = self::settings();
		$score   = 0;
		$reasons = array();
		$session = function_exists( 'WC' ) && WC()->session ? WC()->session : null;
		$ua      = isset( $_SERVER['HTTP_USER_AGENT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ) : '';
		$ip      = class_exists( 'WC_Geolocation' ) ? WC_Geolocation::get_ip_address() : '';

		if ( ! empty( $input['honeypot'] ) ) {
			$score    += 100;
			$reasons[] = 'filled a hidden field';
		}
		if ( '' === $ua || preg_match( self::BOT_UA, $ua ) ) {
			$score    += 60;
			$reasons[] = '' === $ua ? 'no browser name' : 'sent by a script, not a browser';
		}
		if ( $session && ! $session->get( 'ffc_human' ) ) {
			$score    += 45;
			$reasons[] = 'no typing, tapping or clicking on the checkout';
		}
		$opened = $session ? (int) $session->get( 'ffc_opened_at' ) : 0;
		if ( $s['min_seconds'] > 0 && ( ! $opened || time() - $opened < $s['min_seconds'] ) ) {
			$score    += 35;
			$reasons[] = $opened ? sprintf( 'sent %d s after opening the checkout', time() - $opened ) : 'checkout page never opened';
		}
		if ( $ip ) {
			$key   = 'ffc_ip_' . md5( $ip );
			$count = (int) get_transient( $key );
			if ( $count >= $s['ip_hourly'] ) {
				$score    += 30;
				$reasons[] = sprintf( '%d orders from this IP in the last hour', $count );
			}
		}
		if ( self::turnstile_on() && ! empty( $input['classic'] ) ) {
			$ok = self::turnstile_ok( (string) ( $input['turnstile'] ?? '' ), $ip );
			if ( false === $ok ) {
				$score    += 100;
				$reasons[] = 'did not pass the Cloudflare check';
			}
		}
		return array( 'score' => min( 100, $score ), 'reasons' => $reasons );
	}

	/** Counts a placed order against its IP (for the hourly limit). */
	private static function count_ip() {
		$ip = class_exists( 'WC_Geolocation' ) ? WC_Geolocation::get_ip_address() : '';
		if ( $ip ) {
			$key = 'ffc_ip_' . md5( $ip );
			set_transient( $key, (int) get_transient( $key ) + 1, HOUR_IN_SECONDS );
		}
	}

	// --- checkout ------------------------------------------------------------------------------------

	/**
	 * The whole check for one checkout.
	 *
	 * @return array{refuse:string|null,risk:array|null}
	 */
	public static function check( $phone, $input ) {
		$s = self::settings();
		$e = self::phone_error( $phone );
		if ( $e ) {
			self::log( 'phone', $phone, $e );
			FFC_Stats::bump( 'blocked' );
			return array( 'refuse' => $e, 'risk' => null );
		}
		if ( 'off' === $s['bot_mode'] ) {
			return array( 'refuse' => null, 'risk' => null );
		}
		$risk = self::risk( $input );
		if ( 'block' === $s['bot_mode'] && $risk['score'] >= self::BLOCK_AT ) {
			self::log( 'bot_blocked', $phone, implode( ', ', $risk['reasons'] ), $risk['score'] );
			FFC_Stats::bump( 'blocked' );
			return array( 'refuse' => __( 'We could not confirm this order automatically. Please wait a moment and try again, or contact us to order.', 'fullfilio-connect' ), 'risk' => $risk );
		}
		return array( 'refuse' => null, 'risk' => $risk );
	}

	public static function check_classic( $data, $errors ) {
		if ( ! is_array( $data ) || ! is_object( $errors ) || ( method_exists( $errors, 'has_errors' ) && $errors->has_errors() ) ) {
			return;
		}
		$phone = ! empty( $data['billing_phone'] ) ? $data['billing_phone'] : ( $data['shipping_phone'] ?? '' );
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- WooCommerce checked the checkout nonce.
		$input = array(
			'classic'   => true,
			'honeypot'  => isset( $_POST['ffc_website'] ) ? sanitize_text_field( wp_unslash( $_POST['ffc_website'] ) ) : '',
			'turnstile' => isset( $_POST['cf-turnstile-response'] ) ? sanitize_text_field( wp_unslash( $_POST['cf-turnstile-response'] ) ) : '',
		);
		// phpcs:enable
		$r = self::check( $phone, $input );
		if ( $r['refuse'] ) {
			$errors->add( 'ffc_protect', $r['refuse'] );
			return;
		}
		if ( function_exists( 'WC' ) && WC()->session ) {
			WC()->session->set( 'ffc_risk', $r['risk'] );
		}
	}

	/** Block checkout: the phone and bot check; the order exists already (draft). */
	public static function check_blocks( $order, $request ) {
		if ( ! $order instanceof WC_Order ) {
			return;
		}
		$phone = $order->get_billing_phone() ? $order->get_billing_phone() : $order->get_shipping_phone();
		$r     = self::check( $phone, array( 'classic' => false ) );
		if ( $r['refuse'] ) {
			if ( class_exists( '\Automattic\WooCommerce\StoreApi\Exceptions\RouteException' ) ) {
				throw new \Automattic\WooCommerce\StoreApi\Exceptions\RouteException( 'ffc_protect', $r['refuse'], 400 ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped
			}
			throw new Exception( $r['refuse'] ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped
		}
		self::mark( $order, $r['risk'] );
		self::clean_phone( $order );
	}

	/** Classic checkout: the order now exists; keep the clean number and the risk on it. */
	public static function order_created( $order ) {
		if ( ! $order instanceof WC_Order ) {
			return;
		}
		$risk = function_exists( 'WC' ) && WC()->session ? WC()->session->get( 'ffc_risk' ) : null;
		self::mark( $order, is_array( $risk ) ? $risk : null );
		self::clean_phone( $order );
		self::count_ip();
		if ( function_exists( 'WC' ) && WC()->session ) {
			WC()->session->set( 'ffc_risk', null );
			WC()->session->set( 'ffc_opened_at', null );
		}
	}

	private static function clean_phone( $order ) {
		if ( 'off' === self::settings()['phone_mode'] ) {
			return;
		}
		$n = self::normalize_phone( $order->get_billing_phone() );
		if ( $n && $n !== $order->get_billing_phone() ) {
			$order->set_billing_phone( $n );
			$order->save();
		}
	}

	/** Flag mode (or a low score in block mode): the order goes through with the risk noted. */
	private static function mark( $order, $risk ) {
		if ( ! is_array( $risk ) || $risk['score'] <= 0 ) {
			return;
		}
		$order->update_meta_data( '_ffc_risk', wp_json_encode( $risk ) );
		$order->save();
		if ( $risk['score'] >= 40 ) {
			$order->add_order_note( sprintf( 'Fullfilio: possible bot or fake order (risk %d/100: %s).', $risk['score'], implode( ', ', $risk['reasons'] ) ) );
			self::log( 'bot_flagged', $order->get_billing_phone(), implode( ', ', $risk['reasons'] ), $risk['score'], $order->get_id() );
			FFC_Stats::bump( 'flagged' );
		}
	}

	// --- log -------------------------------------------------------------------------------------

	private static function log( $kind, $phone, $why, $score = null, $order_id = null ) {
		$log = get_option( self::LOG, array() );
		$log = is_array( $log ) ? $log : array();
		$d   = preg_replace( '/\D/', '', (string) $phone );
		array_unshift(
			$log,
			array(
				'at'       => gmdate( 'Y-m-d H:i:s' ),
				'kind'     => $kind,
				'phone'    => $d ? str_repeat( '•', max( 0, strlen( $d ) - 3 ) ) . substr( $d, -3 ) : '',
				'why'      => substr( (string) $why, 0, 200 ),
				'score'    => $score,
				'order_id' => $order_id,
			)
		);
		update_option( self::LOG, array_slice( $log, 0, self::LOG_MAX ), false );
	}

	public static function recent( $n = 20 ) {
		$log = get_option( self::LOG, array() );
		return array_slice( is_array( $log ) ? $log : array(), 0, $n );
	}
}
