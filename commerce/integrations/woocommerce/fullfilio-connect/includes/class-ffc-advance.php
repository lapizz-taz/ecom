<?php
/**
 * Advance payment by delivery level.
 *
 * Fullfilio's order shield tells the plugin the customer's delivery level:
 *   GOOD / MID / LOW  the courier success rate against the store's thresholds,
 *   NEW               too few parcels to judge,
 *   ERROR             the courier record could not be read in time.
 * Fullfilio decides first (Settings → Fraud): when it asks for an advance, that
 * amount is collected here. Optionally the store also picks a rule per level on
 * this page: cash on delivery (no advance), the full delivery charge, a fixed
 * amount, or a percentage of the order or of the delivery charge; the larger
 * amount applies.
 *
 * How it is collected: cash on delivery is refused for the order and an online
 * payment method takes the advance. A negative fee line ("Pay on delivery
 * (cash)") holds the rest, so the gateway charges only the advance, and the
 * order keeps _ffc_cod_due so Fullfilio records the full order value with the
 * advance as paid. The fee line is added only while the checkout is being
 * calculated, so the customer always sees what they will pay; without it they
 * simply pay the whole order online. The amount is checked again on the server
 * when the order is placed; the browser only asks for it early.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Advance {
	const OPTION          = 'ffc_advance';
	const SESSION         = 'ffc_advance';
	const FEE_ID          = 'ffc-cod-due';
	const LEVELS          = array( 'GOOD', 'MID', 'LOW', 'NEW', 'ERROR' );
	const RULES           = array( 'cod', 'delivery', 'fixed', 'percent_order', 'percent_delivery' );
	const OFFLINE         = array( 'cod', 'bacs', 'cheque' );
	const QUOTE_PHONES    = 5;  // different numbers one checkout session may ask about
	const QUOTE_IP_HOURLY = 30; // lookups per IP address per hour

	/** What the last check at checkout found, saved on the order when it is created. */
	private static $pending = null;

	public static function defaults() {
		return array(
			'enabled'  => false,
			'rules'    => array(
				'GOOD'  => array( 'rule' => 'cod', 'value' => 0 ),
				'MID'   => array( 'rule' => 'delivery', 'value' => 0 ),
				'LOW'   => array( 'rule' => 'delivery', 'value' => 0 ),
				'NEW'   => array( 'rule' => 'cod', 'value' => 0 ),
				'ERROR' => array( 'rule' => 'cod', 'value' => 0 ),
			),
			'gateways' => array(), // empty: every online payment method
			'hide_cod' => true,
			'label'    => 'Pay on delivery (cash)',
			'message'  => 'This order needs an advance of {amount}. Pay it now with an online payment method; the remaining {due} is paid in cash on delivery.',
		);
	}

	public static function settings() {
		$d     = self::defaults();
		$saved = get_option( self::OPTION, array() );
		$saved = is_array( $saved ) ? $saved : array();
		$out   = array_merge( $d, $saved );
		$out['rules'] = $d['rules'];
		foreach ( self::LEVELS as $level ) {
			if ( isset( $saved['rules'][ $level ] ) && is_array( $saved['rules'][ $level ] ) ) {
				$out['rules'][ $level ] = array_merge( $d['rules'][ $level ], $saved['rules'][ $level ] );
			}
		}
		$out['gateways'] = is_array( $out['gateways'] ) ? array_values( $out['gateways'] ) : array();
		return $out;
	}

	/**
	 * Keeps only known values. $input: enabled, rule_<LEVEL>, value_<LEVEL>,
	 * gateways (list of ids), hide_cod, label, message.
	 */
	public static function save( $input ) {
		$d   = self::defaults();
		$new = array(
			'enabled'  => ! empty( $input['enabled'] ),
			'rules'    => array(),
			'gateways' => array(),
			'hide_cod' => ! empty( $input['hide_cod'] ),
			'label'    => self::text( $input['label'] ?? '', 60, $d['label'] ),
			'message'  => self::text( $input['message'] ?? '', 300, $d['message'] ),
		);
		foreach ( self::LEVELS as $level ) {
			$rule  = (string) ( $input[ 'rule_' . $level ] ?? '' );
			$rule  = in_array( $rule, self::RULES, true ) ? $rule : $d['rules'][ $level ]['rule'];
			$value = (float) ( $input[ 'value_' . $level ] ?? 0 );
			$max   = 'fixed' === $rule ? 1000000 : 100;
			$new['rules'][ $level ] = array( 'rule' => $rule, 'value' => in_array( $rule, array( 'cod', 'delivery' ), true ) ? 0 : max( 0, min( $max, round( $value, 2 ) ) ) );
		}
		foreach ( (array) ( $input['gateways'] ?? array() ) as $id ) {
			$id = preg_replace( '/[^a-z0-9_-]/', '', strtolower( (string) $id ) );
			if ( '' !== $id && ! in_array( $id, self::OFFLINE, true ) && count( $new['gateways'] ) < 30 ) {
				$new['gateways'][] = $id;
			}
		}
		update_option( self::OPTION, $new, false );
		return $new;
	}

	private static function text( $value, $max, $fallback ) {
		$value = trim( wp_strip_all_tags( (string) $value ) );
		if ( '' === $value ) {
			return $fallback;
		}
		return function_exists( 'mb_substr' ) ? mb_substr( $value, 0, $max ) : substr( $value, 0, $max );
	}

	/**
	 * Follows Fullfilio whenever the order shield is on: when Fullfilio's rules
	 * (Settings → Fraud) ask for an advance, an online payment takes that amount.
	 * The per-level rules on this page ("enabled") are an optional extra on top.
	 */
	public static function on() {
		return FFC_Settings::enabled( 'shield' );
	}

	/** The store's own per-level amounts on this page are switched on. */
	public static function local_rules() {
		$s = self::settings();
		return (bool) $s['enabled'];
	}

	/** Online payment methods switched on in WooCommerce that can take an advance. */
	public static function online_gateways() {
		$out = array();
		if ( function_exists( 'WC' ) && is_object( WC() ) && method_exists( WC(), 'payment_gateways' ) && WC()->payment_gateways() ) {
			foreach ( WC()->payment_gateways()->payment_gateways() as $id => $g ) {
				if ( 'yes' === ( isset( $g->enabled ) ? $g->enabled : 'no' ) && self::is_advance_gateway( $id ) ) {
					$out[] = (string) $id;
				}
			}
		}
		return $out;
	}

	public static function init() {
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'assets' ) );
		add_action( 'wc_ajax_ffc_advance', array( __CLASS__, 'quote' ) );
		add_action( 'init', array( __CLASS__, 'register_blocks_update' ) );
		add_action( 'woocommerce_cart_calculate_fees', array( __CLASS__, 'fees' ), 99 );
		add_filter( 'woocommerce_available_payment_gateways', array( __CLASS__, 'gateways' ), 50 );
		add_action( 'woocommerce_review_order_after_order_total', array( __CLASS__, 'review_row' ) );
		// After the order shield (priority 20).
		add_action( 'woocommerce_after_checkout_validation', array( __CLASS__, 'check_classic' ), 25, 2 );
		add_action( 'woocommerce_checkout_create_order', array( __CLASS__, 'save_on_order' ), 20 );
		add_action( 'woocommerce_checkout_create_order_fee_item', array( __CLASS__, 'tag_fee' ), 10, 3 );
		add_action( 'woocommerce_store_api_checkout_update_order_from_request', array( __CLASS__, 'check_blocks' ), 25, 2 );
	}

	// --- amounts -------------------------------------------------------------------------------

	/** One rule's amount for an order worth $base with $delivery as its delivery charge. */
	public static function rule_amount( $rule, $value, $base, $delivery ) {
		switch ( $rule ) {
			case 'delivery':
				return (float) $delivery;
			case 'fixed':
				return (float) $value;
			case 'percent_order':
				return (float) $base * (float) $value / 100;
			case 'percent_delivery':
				return (float) $delivery * (float) $value / 100;
			default:
				return 0.0;
		}
	}

	/**
	 * What this order needs: array( level, advance, due ). advance is rounded up to
	 * a whole unit and never more than the order; due is what stays cash on delivery.
	 *
	 * @param array $decision FFC_Checkout::decision() answer (decision, level, advance_amount).
	 */
	public static function plan( $decision, $base, $delivery ) {
		$s     = self::settings();
		$level = isset( $decision['level'] ) ? (string) $decision['level'] : '';
		$base  = max( 0, (float) $base );
		$need  = 0.0;
		if ( $s['enabled'] && isset( $s['rules'][ $level ] ) ) {
			$need = self::rule_amount( $s['rules'][ $level ]['rule'], $s['rules'][ $level ]['value'], $base, $delivery );
		}
		// Fullfilio's own rules asked for an advance: never less than that.
		if ( isset( $decision['decision'] ) && 'advance' === $decision['decision'] ) {
			$server = isset( $decision['advance_amount'] ) && null !== $decision['advance_amount'] ? (float) $decision['advance_amount'] : (float) $delivery;
			$need   = max( $need, $server > 0 ? $server : $base );
		}
		$need = min( $base, max( 0, ceil( round( $need, 2 ) ) ) );
		return array(
			'level'   => $level,
			'advance' => $need,
			'due'     => $need > 0 && $need < $base ? round( $base - $need, 2 ) : 0.0,
		);
	}

	/** Online methods that may take the advance (the store's list, else every non-offline method). */
	public static function is_advance_gateway( $id ) {
		$id = (string) $id;
		if ( '' === $id || in_array( $id, self::OFFLINE, true ) ) {
			return false;
		}
		$s = self::settings();
		return empty( $s['gateways'] ) || in_array( $id, $s['gateways'], true );
	}

	// --- the shopper's level, kept in their session -------------------------------------------

	private static function digits( $phone ) {
		return preg_replace( '/\D/', '', (string) $phone );
	}

	/** Remembers the latest answer so the checkout can show the fee without asking again. */
	public static function remember( $phone, $decision ) {
		if ( ! function_exists( 'WC' ) || ! WC()->session ) {
			return;
		}
		WC()->session->set(
			self::SESSION,
			array(
				'phone'    => self::digits( $phone ),
				'decision' => isset( $decision['decision'] ) ? (string) $decision['decision'] : 'allow',
				'level'    => isset( $decision['level'] ) ? (string) $decision['level'] : '',
				'advance_amount' => isset( $decision['advance_amount'] ) ? $decision['advance_amount'] : null,
			)
		);
	}

	private static function remembered() {
		if ( ! function_exists( 'WC' ) || ! WC()->session ) {
			return null;
		}
		$r = WC()->session->get( self::SESSION );
		return is_array( $r ) && ! empty( $r['phone'] ) ? $r : null;
	}

	/** The cart's value before our fee, and its delivery charge. */
	private static function cart_numbers( $cart ) {
		$fees = 0.0;
		$ours = 0.0;
		foreach ( $cart->get_fees() as $fee ) {
			if ( isset( $fee->id ) && self::FEE_ID === $fee->id ) {
				$ours += (float) $fee->amount;
				continue;
			}
			$fees += (float) $fee->amount + ( isset( $fee->tax ) ? (float) $fee->tax : 0 );
		}
		$delivery = (float) $cart->get_shipping_total() + (float) $cart->get_shipping_tax();
		$base     = (float) $cart->get_cart_contents_total() + (float) $cart->get_cart_contents_tax() + $delivery + $fees;
		return array( 'base' => round( $base, 2 ), 'delivery' => round( $delivery, 2 ), 'fee' => round( $ours, 2 ) );
	}

	/** The cart's value without our fee (what the order is worth). */
	public static function cart_value( $cart ) {
		$n = self::cart_numbers( $cart );
		return $n['base'];
	}

	/** The order's value without our fee. */
	public static function order_value( $order ) {
		$total = (float) $order->get_total();
		foreach ( $order->get_fees() as $item ) {
			if ( self::is_our_fee( $item ) ) {
				$total -= (float) $item->get_total();
			}
		}
		return round( $total, 2 );
	}

	/** What the cart needs from the remembered level (no request to Fullfilio). */
	private static function cart_plan( $cart ) {
		$r = self::remembered();
		if ( ! $r || ! $cart || 'block' === $r['decision'] ) {
			return null;
		}
		$n = self::cart_numbers( $cart );
		return array_merge( self::plan( $r, $n['base'], $n['delivery'] ), $n );
	}

	private static function chosen_method() {
		return function_exists( 'WC' ) && WC()->session ? (string) WC()->session->get( 'chosen_payment_method' ) : '';
	}

	// --- checkout ------------------------------------------------------------------------------

	/**
	 * On the checkout with the order shield on: the number is checked as soon as it is typed,
	 * so the courier record is ready (and the right payment options shown) by the time the
	 * customer places the order. With the advance payment on, the totals follow it too.
	 */
	public static function assets() {
		if ( ! FFC_Settings::enabled( 'shield' ) || ! function_exists( 'is_checkout' ) || ! is_checkout() || ( function_exists( 'is_order_received_page' ) && is_order_received_page() ) ) {
			return;
		}
		wp_enqueue_script( 'ffc-advance', FFC_URL . 'assets/ffc-advance.js', array(), FFC_VERSION, true );
		wp_localize_script(
			'ffc-advance',
			'ffcAdvance',
			array(
				'quoteUrl' => class_exists( 'WC_AJAX' ) ? WC_AJAX::get_endpoint( 'ffc_advance' ) : '',
				'advance'  => self::on(),
			)
		);
	}

	/**
	 * Looks the number up once it is typed (rate limited: a lookup can cost the store
	 * a courier-record credit) and remembers the level for this checkout.
	 *
	 * @return array|null the plan for the current cart, or null when not looked up.
	 */
	private static function lookup( $phone ) {
		if ( ! FFC_Settings::enabled( 'shield' ) || ! function_exists( 'WC' ) || ! WC()->session || ! WC()->cart || WC()->cart->is_empty() ) {
			return null;
		}
		$digits = self::digits( $phone );
		if ( strlen( $digits ) < 10 || strlen( $digits ) > 15 ) {
			return null;
		}
		$seen = (array) WC()->session->get( 'ffc_advance_phones', array() );
		$hash = md5( $digits );
		if ( ! in_array( $hash, $seen, true ) ) {
			if ( count( $seen ) >= self::QUOTE_PHONES ) {
				return null;
			}
			$ip  = class_exists( 'WC_Geolocation' ) ? WC_Geolocation::get_ip_address() : '';
			$key = 'ffc_adv_ip_' . md5( (string) $ip );
			$n   = (int) get_transient( $key );
			if ( $n >= self::QUOTE_IP_HOURLY ) {
				return null;
			}
			set_transient( $key, $n + 1, HOUR_IN_SECONDS );
			$seen[] = $hash;
			WC()->session->set( 'ffc_advance_phones', $seen );
		}
		WC()->cart->calculate_totals();
		$n = self::cart_numbers( WC()->cart );
		$d = FFC_Checkout::decision( $phone, $n['base'], '', '' );
		self::remember( $phone, $d );
		return array_merge( self::plan( $d, $n['base'], $n['delivery'] ), array( 'decision' => $d['decision'] ) );
	}

	/** Classic checkout: wc-ajax=ffc_advance with the typed phone. */
	public static function quote() {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- public, rate limited, answers only for the visitor's own cart.
		$phone = isset( $_POST['phone'] ) ? substr( sanitize_text_field( wp_unslash( $_POST['phone'] ) ), 0, 30 ) : '';
		$p     = self::lookup( $phone );
		if ( ! $p ) {
			wp_send_json( array( 'ok' => false ), 200 );
		}
		wp_send_json( array( 'ok' => true, 'advance' => $p['advance'] > 0 && 'block' !== $p['decision'] ), 200 );
	}

	/** Block checkout: extensionCartUpdate({ namespace: 'ffc-advance', data: { phone } }) recalculates the cart. */
	public static function register_blocks_update() {
		if ( ! function_exists( 'woocommerce_store_api_register_update_callback' ) ) {
			return;
		}
		woocommerce_store_api_register_update_callback(
			array(
				'namespace' => 'ffc-advance',
				'callback'  => static function ( $data ) {
					self::lookup( is_array( $data ) && isset( $data['phone'] ) ? substr( sanitize_text_field( (string) $data['phone'] ), 0, 30 ) : '' );
				},
			)
		);
	}

	/** The rest of the order as a negative fee, while an online method is chosen. */
	public static function fees( $cart ) {
		if ( ! self::on() || ! is_object( $cart ) || ! self::is_advance_gateway( self::chosen_method() ) ) {
			return;
		}
		$p = self::cart_plan( $cart );
		if ( ! $p || $p['due'] <= 0 ) {
			return;
		}
		$s = self::settings();
		$cart->fees_api()->add_fee( array( 'id' => self::FEE_ID, 'name' => $s['label'], 'amount' => -1 * $p['due'], 'taxable' => false ) );
	}

	/** Cash on delivery is hidden when the order needs an advance and an online method can take it. */
	public static function gateways( $gateways ) {
		if ( ! is_array( $gateways ) || ! isset( $gateways['cod'] ) || ( is_admin() && ! wp_doing_ajax() ) || ! self::on() ) {
			return $gateways;
		}
		if ( ( function_exists( 'is_checkout_pay_page' ) && is_checkout_pay_page() ) || ! function_exists( 'WC' ) || ! WC()->cart ) {
			return $gateways;
		}
		$s = self::settings();
		$p = $s['hide_cod'] ? self::cart_plan( WC()->cart ) : null;
		if ( ! $p || $p['advance'] <= 0 ) {
			return $gateways;
		}
		foreach ( array_keys( $gateways ) as $id ) {
			if ( self::is_advance_gateway( $id ) ) {
				unset( $gateways['cod'] );
				break;
			}
		}
		return $gateways;
	}

	public static function money( $amount ) {
		$symbol = function_exists( 'get_woocommerce_currency_symbol' ) ? html_entity_decode( get_woocommerce_currency_symbol(), ENT_QUOTES, 'UTF-8' ) : '';
		$dp     = function_exists( 'wc_get_price_decimals' ) ? wc_get_price_decimals() : 0;
		return $symbol . number_format( (float) $amount, (int) $dp );
	}

	public static function message( $plan ) {
		if ( $plan['due'] <= 0 ) {
			/* translators: %s: order total */
			return sprintf( __( 'This order needs to be paid in full online (%s). Cash on delivery is not available for it.', 'fullfilio-connect' ), self::money( $plan['advance'] ) );
		}
		$s = self::settings();
		return strtr( $s['message'], array( '{amount}' => self::money( $plan['advance'] ), '{due}' => self::money( $plan['due'] ) ) );
	}

	/** Classic checkout: a line under the total saying what is paid now and on delivery. */
	public static function review_row() {
		if ( ! self::on() || ! function_exists( 'WC' ) || ! WC()->cart ) {
			return;
		}
		$p = self::cart_plan( WC()->cart );
		if ( ! $p || $p['advance'] <= 0 ) {
			return;
		}
		$text = $p['fee'] < 0
			/* translators: 1: order value, 2: cash due on delivery */
			? sprintf( __( 'Order value %1$s — %2$s of it is paid in cash on delivery.', 'fullfilio-connect' ), self::money( $p['base'] ), self::money( abs( $p['fee'] ) ) )
			: self::message( $p );
		echo '<tr class="ffc-advance-row"><th>' . esc_html__( 'Advance', 'fullfilio-connect' ) . '</th><td>' . esc_html( $text ) . '</td></tr>';
	}

	/**
	 * The check that counts (classic checkout), after the order shield.
	 * Refuses cash on delivery (or an offline method) when an advance is needed, and an
	 * online payment smaller than the advance (when the amount changed since the
	 * checkout was shown, the shopper sees the new total and places the order again).
	 */
	public static function check_classic( $data, $errors ) {
		self::$pending = null;
		if ( ! self::on() || ! is_array( $data ) || ! is_object( $errors ) || ( method_exists( $errors, 'has_errors' ) && $errors->has_errors() ) || ! WC()->cart ) {
			return;
		}
		$phone = ! empty( $data['billing_phone'] ) ? $data['billing_phone'] : ( isset( $data['shipping_phone'] ) ? $data['shipping_phone'] : '' );
		$pm    = isset( $data['payment_method'] ) ? (string) $data['payment_method'] : '';
		$addr  = trim( ( isset( $data['billing_address_1'] ) ? $data['billing_address_1'] : '' ) . ' ' . ( isset( $data['billing_city'] ) ? $data['billing_city'] : '' ) );
		$n     = self::cart_numbers( WC()->cart );
		$error = self::verdict( $phone, $pm, $addr, $n['base'], $n['delivery'], $n['fee'], (float) WC()->cart->get_total( 'edit' ) );
		if ( $error ) {
			$errors->add( 'ffc_advance', $error );
		}
	}

	/** Block checkout (Store API): the same check on the order being placed. */
	public static function check_blocks( $order, $request ) {
		if ( ! self::on() || ! $order instanceof WC_Order ) {
			return;
		}
		$pm    = is_object( $request ) && method_exists( $request, 'get_param' ) ? (string) $request->get_param( 'payment_method' ) : (string) $order->get_payment_method();
		$phone = $order->get_billing_phone() ? $order->get_billing_phone() : $order->get_shipping_phone();
		$fee     = 0.0;
		$removed = false;
		foreach ( $order->get_fees() as $item_id => $item ) {
			if ( self::is_our_fee( $item ) ) {
				if ( ! self::is_advance_gateway( $pm ) ) {
					// The cart still had the fee from an online method; this method pays the whole order.
					$order->remove_item( $item_id );
					$removed = true;
					continue;
				}
				$fee += (float) $item->get_total();
			}
		}
		if ( $removed ) {
			$order->calculate_totals( false );
		}
		$delivery = (float) $order->get_shipping_total() + (float) $order->get_shipping_tax();
		$charged  = (float) $order->get_total();
		$error    = self::verdict( $phone, $pm, trim( $order->get_billing_address_1() . ' ' . $order->get_billing_city() ), $charged - $fee, $delivery, $fee, $charged );
		if ( $error ) {
			if ( class_exists( '\Automattic\WooCommerce\StoreApi\Exceptions\RouteException' ) ) {
				throw new \Automattic\WooCommerce\StoreApi\Exceptions\RouteException( 'ffc_advance', $error, 400 ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped
			}
			throw new Exception( $error ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped
		}
		self::save_on_order( $order );
	}

	/**
	 * The decision for one order. $fee is our (negative) fee already in the total,
	 * $charged what the payment method will take.
	 *
	 * @return string an error for the shopper, or '' when the order may go ahead.
	 */
	public static function verdict( $phone, $pm, $address, $base, $delivery, $fee, $charged ) {
		$d = FFC_Checkout::decision( $phone, $base, $pm, $address );
		if ( 'block' === $d['decision'] ) {
			return ''; // the order shield refuses it with its own message
		}
		self::remember( $phone, $d );
		$p = self::plan( $d, $base, $delivery );
		self::$pending = array( 'level' => $p['level'], 'advance' => $p['advance'], 'cod_due' => $fee < 0 ? abs( $fee ) : 0.0 );
		if ( $fee < 0 && ! self::is_advance_gateway( $pm ) ) {
			return __( 'Please choose the payment method again and place the order.', 'fullfilio-connect' );
		}
		if ( $p['advance'] <= 0 ) {
			return '';
		}
		if ( ! self::is_advance_gateway( $pm ) ) {
			FFC_Log::info( 'Advance needed: cash on delivery refused', array( 'level' => $p['level'], 'advance' => $p['advance'] ) );
			return self::message( $p );
		}
		if ( $charged + 0.01 < $p['advance'] ) {
			/* translators: %s: advance amount */
			return sprintf( __( 'The advance for this order is now %s. Please check the updated total and place the order again.', 'fullfilio-connect' ), self::money( $p['advance'] ) );
		}
		return '';
	}

	private static function is_our_fee( $item ) {
		if ( ! is_object( $item ) ) {
			return false;
		}
		if ( method_exists( $item, 'get_meta' ) && '1' === (string) $item->get_meta( '_ffc_cod_due' ) ) {
			return true;
		}
		$s = self::settings();
		return method_exists( $item, 'get_name' ) && $item->get_name() === $s['label'] && (float) $item->get_total() < 0;
	}

	/** Marks the fee line the order gets from the cart, so it is known later. */
	public static function tag_fee( $item, $fee_key, $fee ) {
		if ( is_object( $fee ) && isset( $fee->id ) && self::FEE_ID === $fee->id && is_object( $item ) ) {
			$item->add_meta_data( '_ffc_cod_due', '1', true );
		}
	}

	/** _ffc_cod_due (string, for Fullfilio) and _ffc_advance on the order. */
	public static function save_on_order( $order ) {
		if ( ! $order instanceof WC_Order ) {
			return;
		}
		$due = 0.0;
		foreach ( $order->get_fees() as $item ) {
			if ( self::is_our_fee( $item ) ) {
				$due += abs( (float) $item->get_total() );
			}
		}
		if ( $due > 0 ) {
			$order->update_meta_data( '_ffc_cod_due', wc_format_decimal( $due, 2 ) );
		} else {
			$order->delete_meta_data( '_ffc_cod_due' );
		}
		if ( self::$pending && ( self::$pending['advance'] > 0 || $due > 0 ) ) {
			$order->update_meta_data( '_ffc_advance', wp_json_encode( array( 'level' => self::$pending['level'], 'advance' => self::$pending['advance'], 'cod_due' => round( $due, 2 ) ) ) );
		}
	}

	/** Recent levels and settings for the plugin page. */
	public static function levels() {
		$state = FFC_Settings::state();
		$l     = isset( $state['levels'] ) && is_array( $state['levels'] ) ? $state['levels'] : array();
		return array_merge( array( 'good_min' => 80, 'mid_min' => 50, 'min_parcels' => 1 ), $l );
	}
}
