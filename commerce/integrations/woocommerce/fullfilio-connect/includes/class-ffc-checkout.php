<?php
/**
 * Checkout-time work:
 *
 * 1. Unfinished checkouts: what the customer typed (phone, name, address) and
 *    the cart, sent as they type so staff can call them back. The cart is read
 *    from WooCommerce on the server, never taken from the browser.
 * 2. Attribution: UTM tags, click ids (fbclid, gclid, ttclid) and the Meta
 *    cookies, kept from the first and the latest visit and saved on the order.
 * 3. Order shield: before the order is created, Fullfilio checks the phone
 *    against the block list and the courier delivery record and answers allow,
 *    block, or "advance needed" (cash on delivery refused, prepaid allowed).
 *    If Fullfilio cannot be reached in time the order goes through (and the
 *    check still runs in Fullfilio after the order arrives).
 */

defined( 'ABSPATH' ) || exit;

class FFC_Checkout {
	const COOKIE     = 'ffc_attr';
	const LEAD_KEY   = 'ffc_lead_id';
	const RATE_LIMIT = 30;

	public static function init() {
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'assets' ) );
		add_action( 'wc_ajax_ffc_lead', array( __CLASS__, 'lead' ) );
		add_action( 'woocommerce_after_checkout_validation', array( __CLASS__, 'shield_classic' ), 20, 2 );
		add_action( 'woocommerce_store_api_checkout_update_order_from_request', array( __CLASS__, 'shield_blocks' ), 20, 2 );
		add_action( 'woocommerce_checkout_order_created', array( __CLASS__, 'order_created' ) );
		add_action( 'woocommerce_store_api_checkout_order_processed', array( __CLASS__, 'order_created' ) );
	}

	public static function assets() {
		if ( ! FFC_Settings::connected() || is_admin() ) {
			return;
		}
		$capture = FFC_Settings::enabled( 'capture_leads' ) && function_exists( 'is_checkout' ) && is_checkout() && ! ( function_exists( 'is_order_received_page' ) && is_order_received_page() );
		if ( ! FFC_Settings::enabled( 'attribution' ) && ! $capture ) {
			return;
		}
		wp_enqueue_script( 'ffc', FFC_URL . 'assets/ffc.js', array(), FFC_VERSION, true );
		wp_localize_script(
			'ffc',
			'ffcConfig',
			array(
				'attribution' => FFC_Settings::enabled( 'attribution' ),
				'capture'     => $capture,
				'leadUrl'     => class_exists( 'WC_AJAX' ) ? WC_AJAX::get_endpoint( 'ffc_lead' ) : '',
				'cookie'      => self::COOKIE,
			)
		);
	}

	// --- unfinished checkouts ----------------------------------------------------------------

	public static function lead() {
		if ( ! FFC_Settings::enabled( 'capture_leads' ) || ! function_exists( 'WC' ) || ! WC()->session || ! WC()->cart ) {
			wp_send_json( array( 'ok' => false ), 200 );
		}
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- public, rate limited, and only describes the visitor's own cart.
		$field = static function ( $key, $max ) {
			return isset( $_POST[ $key ] ) ? substr( sanitize_text_field( wp_unslash( $_POST[ $key ] ) ), 0, $max ) : '';
		};
		$phone = preg_replace( '/[^\d+]/', '', $field( 'phone', 30 ) );
		$data  = array(
			'phone'    => $phone,
			'name'     => trim( $field( 'first_name', 60 ) . ' ' . $field( 'last_name', 60 ) ),
			'email'    => sanitize_email( $field( 'email', 120 ) ),
			'address'  => trim( $field( 'address_1', 200 ) . ' ' . $field( 'address_2', 100 ) ),
			'city'     => $field( 'city', 80 ),
			'state'    => $field( 'state', 40 ),
			'postcode' => $field( 'postcode', 20 ),
			'country'  => $field( 'country', 2 ),
			'note'     => $field( 'note', 300 ),
		);
		// phpcs:enable
		if ( strlen( preg_replace( '/\D/', '', $phone ) ) < 10 || WC()->cart->is_empty() ) {
			wp_send_json( array( 'ok' => false, 'reason' => 'incomplete' ), 200 );
		}
		$count = (int) WC()->session->get( 'ffc_lead_sends', 0 );
		if ( $count >= self::RATE_LIMIT ) {
			wp_send_json( array( 'ok' => false, 'reason' => 'limit' ), 429 );
		}
		$lead_id = WC()->session->get( self::LEAD_KEY );
		if ( ! $lead_id ) {
			$lead_id = 'ffc-' . FFC_Signer::uuid();
			WC()->session->set( self::LEAD_KEY, $lead_id );
			FFC_Stats::bump( 'leads' );
			WC()->session->set( 'ffc_lead_started', gmdate( 'c' ) );
		}
		$payload = array_merge( $data, self::cart(), array( 'id' => $lead_id, 'created_at' => WC()->session->get( 'ffc_lead_started' ), 'updated_at' => gmdate( 'c' ), 'checkout_url' => wc_get_checkout_url(), 'attribution' => self::attribution() ) );
		// The same details twice in a row are not sent again.
		$signature = md5( wp_json_encode( array( $data, $payload['items'], $payload['total'] ) ) );
		if ( WC()->session->get( 'ffc_lead_sig' ) === $signature ) {
			wp_send_json( array( 'ok' => true, 'unchanged' => true ), 200 );
		}
		WC()->session->set( 'ffc_lead_sig', $signature );
		WC()->session->set( 'ffc_lead_sends', $count + 1 );
		FFC_Outbox::push( 'lead', $payload );
		wp_send_json( array( 'ok' => true ), 200 );
	}

	/** The visitor's cart as WooCommerce has it. */
	private static function cart() {
		$items = array();
		foreach ( WC()->cart->get_cart() as $line ) {
			$product = isset( $line['data'] ) ? $line['data'] : null;
			if ( ! $product || ! is_object( $product ) ) {
				continue;
			}
			$items[] = array(
				'product_id'   => (int) $line['product_id'],
				'variation_id' => (int) ( isset( $line['variation_id'] ) ? $line['variation_id'] : 0 ),
				'title'        => $product->get_name(),
				'sku'          => $product->get_sku(),
				'quantity'     => (int) $line['quantity'],
				'price'        => (float) wc_format_decimal( $product->get_price(), 2 ),
				'line_total'   => (float) wc_format_decimal( isset( $line['line_total'] ) ? $line['line_total'] : 0, 2 ),
			);
		}
		WC()->cart->calculate_totals();
		return array(
			'items'    => array_slice( $items, 0, 50 ),
			'subtotal' => (float) wc_format_decimal( WC()->cart->get_subtotal(), 2 ),
			'shipping' => (float) wc_format_decimal( WC()->cart->get_shipping_total(), 2 ),
			'total'    => (float) wc_format_decimal( WC()->cart->get_total( 'edit' ), 2 ),
			'currency' => get_woocommerce_currency(),
		);
	}

	// --- attribution -------------------------------------------------------------------------

	/** First and latest visit (from our cookie) plus the Meta cookies, IP and browser. */
	public static function attribution() {
		$raw   = isset( $_COOKIE[ self::COOKIE ] ) ? wp_unslash( $_COOKIE[ self::COOKIE ] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- decoded and cleaned below.
		$value = json_decode( (string) $raw, true );
		$clean = static function ( $touch ) {
			if ( ! is_array( $touch ) ) {
				return null;
			}
			$params = array();
			foreach ( ( isset( $touch['params'] ) && is_array( $touch['params'] ) ? $touch['params'] : array() ) as $k => $v ) {
				if ( preg_match( '/^[a-z_]{2,30}$/', (string) $k ) && is_scalar( $v ) && count( $params ) < 20 ) {
					$params[ $k ] = substr( sanitize_text_field( (string) $v ), 0, 200 );
				}
			}
			return array(
				'at'       => isset( $touch['at'] ) ? substr( sanitize_text_field( (string) $touch['at'] ), 0, 40 ) : gmdate( 'c' ),
				'landing'  => isset( $touch['landing'] ) ? substr( esc_url_raw( (string) $touch['landing'] ), 0, 300 ) : '',
				'referrer' => isset( $touch['referrer'] ) ? substr( esc_url_raw( (string) $touch['referrer'] ), 0, 300 ) : null,
				// An object even when empty: an empty PHP array would be sent as a JSON list.
				'params'   => (object) $params,
			);
		};
		$cookie = static function ( $name ) {
			return isset( $_COOKIE[ $name ] ) ? substr( sanitize_text_field( wp_unslash( $_COOKIE[ $name ] ) ), 0, 200 ) : null;
		};
		return array(
			'first_touch' => is_array( $value ) ? $clean( isset( $value['first'] ) ? $value['first'] : null ) : null,
			'last_touch'  => is_array( $value ) ? $clean( isset( $value['last'] ) ? $value['last'] : null ) : null,
			'fbp'         => $cookie( '_fbp' ),
			'fbc'         => $cookie( '_fbc' ),
			'ip'          => class_exists( 'WC_Geolocation' ) ? WC_Geolocation::get_ip_address() : ( isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : null ),
			'user_agent'  => isset( $_SERVER['HTTP_USER_AGENT'] ) ? substr( sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ), 0, 300 ) : null,
		);
	}

	/** Saves attribution on the new order and closes the unfinished checkout. */
	public static function order_created( $order ) {
		if ( ! FFC_Settings::connected() || ! $order instanceof WC_Order ) {
			return;
		}
		if ( FFC_Settings::enabled( 'attribution' ) && ! $order->get_meta( '_ffc_attribution' ) ) {
			$order->update_meta_data( '_ffc_attribution', wp_json_encode( self::attribution() ) );
		}
		$lead_id = function_exists( 'WC' ) && WC()->session ? WC()->session->get( self::LEAD_KEY ) : null;
		if ( $lead_id && ! $order->get_meta( '_ffc_lead_id' ) ) {
			$order->update_meta_data( '_ffc_lead_id', $lead_id );
			FFC_Outbox::push( 'lead_completed', array( 'id' => $lead_id, 'order_id' => $order->get_id(), 'completed_at' => gmdate( 'c' ) ) );
			WC()->session->set( self::LEAD_KEY, null );
			WC()->session->set( 'ffc_lead_sig', null );
			WC()->session->set( 'ffc_lead_sends', 0 );
		}
		$order->save_meta_data();
	}

	// --- order shield ------------------------------------------------------------------------

	/**
	 * Fullfilio's answer for this phone and order: allow | block | advance.
	 *
	 * @return array{decision:string,message:string}
	 */
	public static function decision( $phone, $total, $payment_method, $address ) {
		$allow = array( 'decision' => 'allow', 'message' => '' );
		if ( ! FFC_Settings::enabled( 'shield' ) ) {
			return $allow;
		}
		$digits = preg_replace( '/\D/', '', (string) $phone );
		if ( strlen( $digits ) < 10 ) {
			return $allow;
		}
		$cache_key = 'ffc_dec_' . md5( $digits . '|' . round( (float) $total ) . '|' . $payment_method );
		$cached    = get_transient( $cache_key );
		if ( is_array( $cached ) ) {
			return $cached;
		}
		$config = FFC_Settings::config();
		$ip     = class_exists( 'WC_Geolocation' ) ? WC_Geolocation::get_ip_address() : '';
		$result = FFC_Api::send(
			'checkout_check',
			array( 'phone' => $phone, 'total' => (float) $total, 'payment_method' => $payment_method, 'address' => $address, 'ip' => $ip ),
			null,
			(int) $config['shield_timeout']
		);
		if ( ! $result['ok'] ) {
			FFC_Log::warning( 'Order shield could not reach Fullfilio: ' . $result['error'] . ( $config['shield_fail_open'] ? ' (order allowed)' : ' (order held)' ) );
			if ( $config['shield_fail_open'] ) {
				return $allow;
			}
			return array( 'decision' => 'block', 'message' => __( 'We could not confirm your order right now. Please try again in a minute.', 'fullfilio-connect' ) );
		}
		$decision = isset( $result['body']['decision'] ) ? (string) $result['body']['decision'] : 'allow';
		$out      = array(
			'decision' => in_array( $decision, array( 'allow', 'block', 'advance' ), true ) ? $decision : 'allow',
			'message'  => isset( $result['body']['message'] ) ? wp_strip_all_tags( (string) $result['body']['message'] ) : '',
		);
		set_transient( $cache_key, $out, 10 * MINUTE_IN_SECONDS );
		if ( 'allow' !== $out['decision'] ) {
			FFC_Log::info( 'Order shield: ' . $out['decision'], array( 'phone_end' => substr( $digits, -3 ) ) );
		}
		return $out;
	}

	/** Cash on delivery (or no payment) cannot go ahead when an advance is required. */
	private static function refuses( $decision, $payment_method ) {
		if ( 'block' === $decision['decision'] ) {
			return true;
		}
		return 'advance' === $decision['decision'] && ( '' === (string) $payment_method || 'cod' === $payment_method );
	}

	private static function message( $decision ) {
		if ( '' !== $decision['message'] ) {
			return $decision['message'];
		}
		return 'advance' === $decision['decision']
			? __( 'To confirm this order please pay in advance with an online payment method.', 'fullfilio-connect' )
			: __( 'We are unable to accept this order online. Please contact us to complete your purchase.', 'fullfilio-connect' );
	}

	/** Classic checkout (shortcode). */
	public static function shield_classic( $data, $errors ) {
		if ( ! is_array( $data ) || ! is_object( $errors ) || ( method_exists( $errors, 'has_errors' ) && $errors->has_errors() ) ) {
			return;
		}
		$phone = ! empty( $data['billing_phone'] ) ? $data['billing_phone'] : ( isset( $data['shipping_phone'] ) ? $data['shipping_phone'] : '' );
		$total = function_exists( 'WC' ) && WC()->cart ? WC()->cart->get_total( 'edit' ) : 0;
		$pm    = isset( $data['payment_method'] ) ? (string) $data['payment_method'] : '';
		$addr  = trim( ( isset( $data['billing_address_1'] ) ? $data['billing_address_1'] : '' ) . ' ' . ( isset( $data['billing_city'] ) ? $data['billing_city'] : '' ) );
		$d     = self::decision( $phone, $total, $pm, $addr );
		if ( self::refuses( $d, $pm ) ) {
			$errors->add( 'ffc_shield', self::message( $d ) );
		}
	}

	/** Block checkout (Store API). */
	public static function shield_blocks( $order, $request ) {
		if ( ! $order instanceof WC_Order ) {
			return;
		}
		$phone = $order->get_billing_phone() ? $order->get_billing_phone() : $order->get_shipping_phone();
		$pm    = is_object( $request ) && method_exists( $request, 'get_param' ) ? (string) $request->get_param( 'payment_method' ) : (string) $order->get_payment_method();
		$d     = self::decision( $phone, $order->get_total(), $pm, trim( $order->get_billing_address_1() . ' ' . $order->get_billing_city() ) );
		if ( self::refuses( $d, $pm ) ) {
			if ( class_exists( '\Automattic\WooCommerce\StoreApi\Exceptions\RouteException' ) ) {
				throw new \Automattic\WooCommerce\StoreApi\Exceptions\RouteException( 'ffc_shield', self::message( $d ), 400 ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped
			}
			throw new Exception( self::message( $d ) ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped
		}
	}
}
