<?php
/**
 * Advanced ad tracking: Meta (Pixel + Conversions API), TikTok (Pixel + Events
 * API) and Google (Ads gtag + GA4 Measurement Protocol / Enhanced Conversions).
 *
 * The point for cash-on-delivery sellers: a browser "Purchase" the moment an
 * order is placed teaches the ad platforms to chase orders that are never
 * confirmed or never received. So the conversion is HELD and only sent
 * server-side once the order is CALL-CONFIRMED (status reaches Confirmed, or
 * Delivered if chosen), and it is NOT sent for a low-receive-rate (risky)
 * customer. Click ids (fbc/fbp, ttclid, gclid/wbraid) and hashed customer data
 * are matched server to server, with one event id per order so a browser Pixel
 * and the server event de-duplicate.
 *
 * The merchant enters their own Pixel ids and API tokens here (their own ad
 * accounts); nothing is shown to shoppers and the tokens are never echoed back.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Tracking {
	const OPTION  = 'ffc_tracking';
	const SENT    = '_ffc_track_sent';
	const RR_META = '_ffc_receive_rate';
	const LOG_OPT = 'ffc_track_log';
	const GRAPH   = 'https://graph.facebook.com/v19.0';
	const TIKTOK  = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
	const GA4_MP  = 'https://www.google-analytics.com/mp/collect';

	public static function defaults() {
		return array(
			'meta'             => array( 'on' => false, 'pixel' => '', 'token' => '', 'test' => '' ),
			'tiktok'           => array( 'on' => false, 'pixel' => '', 'token' => '', 'test' => '' ),
			'google'           => array( 'on' => false, 'conv_id' => '', 'conv_label' => '', 'ga4_id' => '', 'ga4_secret' => '' ),
			'trigger'          => 'confirmed', // confirmed | delivered
			'exclude_low_rr'   => true,
			'min_rr'           => 40,          // orders below this receive-rate % are not sent
			'browser_events'   => true,        // PageView / ViewContent / InitiateCheckout in the browser
			'browser_purchase' => false,       // also fire Purchase in the browser on the thank-you page
		);
	}

	public static function settings() {
		$saved = get_option( self::OPTION, array() );
		$out   = self::defaults();
		if ( is_array( $saved ) ) {
			foreach ( array( 'meta', 'tiktok', 'google' ) as $p ) {
				if ( isset( $saved[ $p ] ) && is_array( $saved[ $p ] ) ) {
					$out[ $p ] = array_merge( $out[ $p ], $saved[ $p ] );
				}
			}
			foreach ( array( 'trigger', 'exclude_low_rr', 'min_rr', 'browser_events', 'browser_purchase' ) as $k ) {
				if ( array_key_exists( $k, $saved ) ) {
					$out[ $k ] = $saved[ $k ];
				}
			}
		}
		return $out;
	}

	/** Saves from the admin form. Tokens left blank keep the stored value; a *_clear flag removes them. */
	public static function save( $in ) {
		$cur = self::settings();
		$s   = self::defaults();
		foreach ( array( 'meta', 'tiktok' ) as $p ) {
			$s[ $p ]['on']    = ! empty( $in[ $p . '_on' ] );
			$s[ $p ]['pixel'] = isset( $in[ $p . '_pixel' ] ) ? preg_replace( '/[^0-9A-Za-z_-]/', '', (string) $in[ $p . '_pixel' ] ) : '';
			$s[ $p ]['test']  = isset( $in[ $p . '_test' ] ) ? preg_replace( '/[^0-9A-Za-z_]/', '', (string) $in[ $p . '_test' ] ) : '';
			$token            = isset( $in[ $p . '_token' ] ) ? trim( (string) $in[ $p . '_token' ] ) : '';
			$s[ $p ]['token'] = ! empty( $in[ $p . '_token_clear' ] ) ? '' : ( '' !== $token ? $token : $cur[ $p ]['token'] );
		}
		$s['google']['on']         = ! empty( $in['google_on'] );
		$s['google']['conv_id']    = isset( $in['google_conv_id'] ) ? preg_replace( '/[^0-9A-Za-z_-]/', '', (string) $in['google_conv_id'] ) : '';
		$s['google']['conv_label'] = isset( $in['google_conv_label'] ) ? preg_replace( '/[^0-9A-Za-z_-]/', '', (string) $in['google_conv_label'] ) : '';
		$s['google']['ga4_id']     = isset( $in['google_ga4_id'] ) ? preg_replace( '/[^0-9A-Za-z_-]/', '', (string) $in['google_ga4_id'] ) : '';
		$secret                    = isset( $in['google_ga4_secret'] ) ? trim( (string) $in['google_ga4_secret'] ) : '';
		$s['google']['ga4_secret'] = ! empty( $in['google_ga4_secret_clear'] ) ? '' : ( '' !== $secret ? $secret : $cur['google']['ga4_secret'] );
		$s['trigger']          = ( isset( $in['trigger'] ) && 'delivered' === $in['trigger'] ) ? 'delivered' : 'confirmed';
		$s['exclude_low_rr']   = ! empty( $in['exclude_low_rr'] );
		$s['min_rr']           = isset( $in['min_rr'] ) ? max( 0, min( 100, (int) $in['min_rr'] ) ) : 40;
		$s['browser_events']   = ! empty( $in['browser_events'] );
		$s['browser_purchase'] = ! empty( $in['browser_purchase'] );
		update_option( self::OPTION, $s, false );
	}

	public static function any_on() {
		$s = self::settings();
		return $s['meta']['on'] || $s['tiktok']['on'] || $s['google']['on'];
	}

	public static function init() {
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
		add_action( 'woocommerce_order_status_changed', array( __CLASS__, 'on_status' ), 30, 4 );
	}

	// --- browser pixels (funnel only; Purchase is held) --------------------------------------

	public static function enqueue() {
		if ( is_admin() || ! self::any_on() ) {
			return;
		}
		$s = self::settings();
		if ( ! $s['browser_events'] && ! $s['browser_purchase'] ) {
			return;
		}
		$page = 'other';
		$product = null;
		if ( function_exists( 'is_product' ) && is_product() ) {
			$page = 'product';
			$p    = function_exists( 'wc_get_product' ) ? wc_get_product( get_the_ID() ) : null;
			if ( $p ) {
				$product = array( 'id' => (string) $p->get_id(), 'name' => $p->get_name(), 'price' => (float) $p->get_price(), 'currency' => get_woocommerce_currency() );
			}
		} elseif ( function_exists( 'is_checkout' ) && is_checkout() && ! ( function_exists( 'is_order_received_page' ) && is_order_received_page() ) ) {
			$page = 'checkout';
		} elseif ( function_exists( 'is_cart' ) && is_cart() ) {
			$page = 'cart';
		}

		// Thank-you page: only fire Purchase in the browser when the merchant opted in.
		$purchase = null;
		if ( $s['browser_purchase'] && function_exists( 'is_order_received_page' ) && is_order_received_page() ) {
			$order_id = absint( get_query_var( 'order-received' ) );
			$order    = $order_id ? wc_get_order( $order_id ) : null;
			if ( $order instanceof WC_Order ) {
				$purchase = array(
					'event_id' => self::event_id( $order ),
					'value'    => (float) $order->get_total(),
					'currency' => $order->get_currency(),
					'contents' => self::contents( $order ),
				);
			}
		}

		$cfg = array(
			'meta'     => $s['meta']['on'] && $s['meta']['pixel'] ? $s['meta']['pixel'] : '',
			'tiktok'   => $s['tiktok']['on'] && $s['tiktok']['pixel'] ? $s['tiktok']['pixel'] : '',
			'gads'     => $s['google']['on'] && $s['google']['conv_id'] ? $s['google']['conv_id'] : '',
			'ga4'      => $s['google']['on'] && $s['google']['ga4_id'] ? $s['google']['ga4_id'] : '',
			'page'     => $page,
			'product'  => $product,
			'purchase' => $purchase,
			'funnel'   => (bool) $s['browser_events'],
		);
		if ( ! $cfg['meta'] && ! $cfg['tiktok'] && ! $cfg['gads'] && ! $cfg['ga4'] ) {
			return;
		}
		wp_enqueue_script( 'ffc-track', FFC_URL . 'assets/ffc-track.js', array(), FFC_VERSION, true );
		wp_localize_script( 'ffc-track', 'ffcTrack', $cfg );
	}

	// --- server-side conversion (held until confirmed, gated on receive rate) ----------------

	/** Statuses that count as "call-confirmed" / trackable for each trigger mode. */
	private static function trigger_statuses( $trigger ) {
		return 'delivered' === $trigger
			? array( 'delivered', 'partial-delivered', 'completed' )
			: array( 'confirmed' );
	}

	public static function on_status( $order_id, $from, $to, $order = null ) {
		if ( ! self::any_on() ) {
			return;
		}
		$s = self::settings();
		if ( ! in_array( $to, self::trigger_statuses( $s['trigger'] ), true ) ) {
			return;
		}
		$order = $order instanceof WC_Order ? $order : wc_get_order( $order_id );
		if ( $order instanceof WC_Order ) {
			self::maybe_send( $order, $s );
		}
	}

	/** The customer's courier receive rate for this order, if known (0-100), else null. */
	private static function receive_rate( $order ) {
		$rr = $order->get_meta( self::RR_META );
		if ( '' !== $rr && null !== $rr && is_numeric( $rr ) ) {
			return (float) $rr;
		}
		// Fallback signal: the order shield asked for an advance / blocked = low delivery success.
		$shield = (string) $order->get_meta( '_ffc_shield' );
		if ( 'advance' === $shield || 'block' === $shield ) {
			return 0.0;
		}
		return null;
	}

	/** True when this order may be sent as a conversion. */
	private static function trackable( $order, $s ) {
		if ( $order->get_meta( self::SENT ) ) {
			return false; // already sent
		}
		if ( $order->get_total() <= 0 ) {
			return false;
		}
		if ( $s['exclude_low_rr'] ) {
			$rr = self::receive_rate( $order );
			if ( null !== $rr && $rr < (float) $s['min_rr'] ) {
				return false; // low receive rate — do not teach the ad platform to chase it
			}
		}
		return true;
	}

	public static function maybe_send( $order, $s = null ) {
		$s = $s ? $s : self::settings();
		if ( ! self::trackable( $order, $s ) ) {
			return;
		}
		$attr   = self::attribution( $order );
		$ud     = self::user_data( $order, $attr );
		$sent   = array();
		$errors = array();
		if ( $s['meta']['on'] && $s['meta']['pixel'] && $s['meta']['token'] ) {
			$r = self::send_meta( $order, $s['meta'], $ud, $attr );
			$r['ok'] ? $sent[] = 'Meta' : $errors[] = 'Meta: ' . $r['error'];
		}
		if ( $s['tiktok']['on'] && $s['tiktok']['pixel'] && $s['tiktok']['token'] ) {
			$r = self::send_tiktok( $order, $s['tiktok'], $ud, $attr );
			$r['ok'] ? $sent[] = 'TikTok' : $errors[] = 'TikTok: ' . $r['error'];
		}
		if ( $s['google']['on'] && $s['google']['ga4_id'] && $s['google']['ga4_secret'] ) {
			$r = self::send_google( $order, $s['google'], $ud, $attr );
			$r['ok'] ? $sent[] = 'Google' : $errors[] = 'Google: ' . $r['error'];
		}
		if ( $sent ) {
			$order->update_meta_data( self::SENT, gmdate( 'c' ) . ' → ' . implode( ', ', $sent ) );
			$order->save_meta_data();
		}
		self::log( $order->get_order_number(), $sent, $errors );
		if ( $errors ) {
			FFC_Log::warning( 'Tracking send issues for #' . $order->get_order_number() . ': ' . implode( ' | ', $errors ) );
		}
	}

	// --- per-platform senders ----------------------------------------------------------------

	private static function send_meta( $order, $cfg, $ud, $attr ) {
		$user = array_filter(
			array(
				'em'                => $ud['email_h'] ? array( $ud['email_h'] ) : null,
				'ph'                => $ud['phone_h'] ? array( $ud['phone_h'] ) : null,
				'fn'                => $ud['fn_h'] ? array( $ud['fn_h'] ) : null,
				'ln'                => $ud['ln_h'] ? array( $ud['ln_h'] ) : null,
				'ct'                => $ud['city_h'] ? array( $ud['city_h'] ) : null,
				'country'           => $ud['country_h'] ? array( $ud['country_h'] ) : null,
				'client_ip_address' => $attr['ip'],
				'client_user_agent' => $attr['ua'],
				'fbc'               => $attr['fbc'],
				'fbp'               => $attr['fbp'],
			)
		);
		$data = array(
			'event_name'       => 'Purchase',
			'event_time'       => time(),
			'event_id'         => self::event_id( $order ),
			'action_source'    => 'website',
			'event_source_url' => $order->get_checkout_order_received_url(),
			'user_data'        => (object) $user,
			'custom_data'      => array(
				'currency'     => $order->get_currency(),
				'value'        => round( (float) $order->get_total(), 2 ),
				'content_type' => 'product',
				'contents'     => self::contents( $order ),
				'content_ids'  => wp_list_pluck( self::contents( $order ), 'id' ),
				'num_items'    => $order->get_item_count(),
			),
		);
		$body = array( 'data' => array( $data ), 'access_token' => $cfg['token'] );
		if ( ! empty( $cfg['test'] ) ) {
			$body['test_event_code'] = $cfg['test'];
		}
		return self::post( self::GRAPH . '/' . rawurlencode( $cfg['pixel'] ) . '/events', $body );
	}

	private static function send_tiktok( $order, $cfg, $ud, $attr ) {
		$user = array_filter(
			array(
				'email'       => $ud['email_h'],
				'phone'       => $ud['phone_h'],
				'external_id' => hash( 'sha256', (string) $order->get_customer_id() ? (string) $order->get_customer_id() : $ud['phone_h'] ),
				'ttclid'      => $attr['ttclid'],
				'ttp'         => $attr['ttp'],
				'ip'          => $attr['ip'],
				'user_agent'  => $attr['ua'],
			)
		);
		$payload = array(
			'event_source'    => 'web',
			'event_source_id' => $cfg['pixel'],
			'data'            => array(
				array(
					'event'        => 'CompletePayment',
					'event_time'   => time(),
					'event_id'     => self::event_id( $order ),
					'user'         => (object) $user,
					'properties'   => array(
						'currency'     => $order->get_currency(),
						'value'        => round( (float) $order->get_total(), 2 ),
						'content_type' => 'product',
						'contents'     => array_map(
							static function ( $c ) {
								return array( 'content_id' => $c['id'], 'content_name' => $c['name'], 'quantity' => $c['quantity'], 'price' => $c['item_price'] );
							},
							self::contents( $order )
						),
					),
					'page'         => array( 'url' => $order->get_checkout_order_received_url() ),
				),
			),
		);
		if ( ! empty( $cfg['test'] ) ) {
			$payload['test_event_code'] = $cfg['test'];
		}
		return self::post( self::TIKTOK, $payload, array( 'Access-Token' => $cfg['token'] ) );
	}

	private static function send_google( $order, $cfg, $ud, $attr ) {
		// GA4 Measurement Protocol with user-provided data for Enhanced Conversions;
		// a 'purchase' event imports into Google Ads when the GA4 property is linked.
		$items = array();
		foreach ( self::contents( $order ) as $c ) {
			$items[] = array( 'item_id' => $c['id'], 'item_name' => $c['name'], 'quantity' => $c['quantity'], 'price' => $c['item_price'] );
		}
		$payload = array(
			'client_id'       => $attr['ga_cid'] ? $attr['ga_cid'] : ( '' !== (string) $attr['fbp'] ? (string) $attr['fbp'] : self::event_id( $order ) ),
			'non_personalized_ads' => false,
			'user_data'       => array_filter(
				array(
					'sha256_email_address' => $ud['email_h'],
					'sha256_phone_number'  => $ud['phone_h'],
				)
			),
			'events'          => array(
				array(
					'name'   => 'purchase',
					'params' => array_filter(
						array(
							'transaction_id' => (string) $order->get_order_number(),
							'value'          => round( (float) $order->get_total(), 2 ),
							'currency'       => $order->get_currency(),
							'items'          => $items,
							'gclid'          => $attr['gclid'],
						)
					),
				),
			),
		);
		$url = add_query_arg(
			array( 'measurement_id' => $cfg['ga4_id'], 'api_secret' => $cfg['ga4_secret'] ),
			self::GA4_MP
		);
		return self::post( $url, $payload );
	}

	/** One signed-less POST to a fixed ad-platform host. */
	private static function post( $url, $body, $headers = array() ) {
		$res = wp_remote_post(
			$url,
			array(
				'timeout'     => 12,
				'redirection' => 0,
				'headers'     => array_merge( array( 'Content-Type' => 'application/json' ), $headers ),
				'body'        => wp_json_encode( $body ),
			)
		);
		if ( is_wp_error( $res ) ) {
			return array( 'ok' => false, 'error' => $res->get_error_message() );
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		if ( $code >= 200 && $code < 300 ) {
			// GA4 MP returns 204 with no body; Meta/TikTok return JSON. TikTok uses code:0 for success.
			$json = json_decode( (string) wp_remote_retrieve_body( $res ), true );
			if ( is_array( $json ) && isset( $json['code'] ) && 0 !== (int) $json['code'] ) {
				return array( 'ok' => false, 'error' => isset( $json['message'] ) ? (string) $json['message'] : 'rejected' );
			}
			return array( 'ok' => true, 'error' => '' );
		}
		$json = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		$msg  = is_array( $json ) && isset( $json['error']['message'] ) ? (string) $json['error']['message'] : ( is_array( $json ) && isset( $json['message'] ) ? (string) $json['message'] : 'HTTP ' . $code );
		return array( 'ok' => false, 'error' => $msg );
	}

	// --- helpers -----------------------------------------------------------------------------

	/** One stable event id per order so a browser Pixel and the server event de-duplicate. */
	public static function event_id( $order ) {
		return 'ffc_ord_' . $order->get_id();
	}

	private static function h( $value ) {
		$value = trim( strtolower( (string) $value ) );
		return '' === $value ? null : hash( 'sha256', $value );
	}

	private static function contents( $order ) {
		$out = array();
		foreach ( $order->get_items() as $item ) {
			if ( ! $item instanceof WC_Order_Item_Product ) {
				continue;
			}
			$product = $item->get_product();
			$out[]   = array(
				'id'         => (string) ( $product ? ( $product->get_sku() ? $product->get_sku() : $product->get_id() ) : $item->get_product_id() ),
				'name'       => $item->get_name(),
				'quantity'   => (int) $item->get_quantity(),
				'item_price' => round( (float) $order->get_item_total( $item, false, false ), 2 ),
			);
		}
		return $out;
	}

	private static function user_data( $order, $attr ) {
		$phone = preg_replace( '/[^\d]/', '', (string) $order->get_billing_phone() );
		// Bangladesh numbers to E.164 (880…) for better matching.
		if ( 11 === strlen( $phone ) && 0 === strpos( $phone, '01' ) ) {
			$phone = '88' . $phone;
		}
		return array(
			'email_h'   => self::h( $order->get_billing_email() ),
			'phone_h'   => $phone ? hash( 'sha256', $phone ) : null,
			'fn_h'      => self::h( $order->get_billing_first_name() ),
			'ln_h'      => self::h( $order->get_billing_last_name() ),
			'city_h'    => self::h( $order->get_billing_city() ),
			'country_h' => self::h( $order->get_billing_country() ),
		);
	}

	/** Click ids and cookies saved on the order by FFC_Checkout (plus live fallbacks). */
	private static function attribution( $order ) {
		$raw  = $order->get_meta( '_ffc_attribution' );
		$a    = $raw ? json_decode( (string) $raw, true ) : array();
		$a    = is_array( $a ) ? $a : array();
		$last = isset( $a['last_touch']['params'] ) && is_array( $a['last_touch']['params'] ) ? $a['last_touch']['params'] : array();
		$first = isset( $a['first_touch']['params'] ) && is_array( $a['first_touch']['params'] ) ? $a['first_touch']['params'] : array();
		$param = static function ( $key ) use ( $last, $first ) {
			if ( ! empty( $last[ $key ] ) ) {
				return (string) $last[ $key ];
			}
			return ! empty( $first[ $key ] ) ? (string) $first[ $key ] : null;
		};
		$fbc = isset( $a['fbc'] ) ? $a['fbc'] : null;
		if ( ! $fbc && $param( 'fbclid' ) ) {
			// Reconstruct the fbc click cookie from the raw fbclid when the cookie was not captured.
			$fbc = 'fb.1.' . ( time() * 1000 ) . '.' . $param( 'fbclid' );
		}
		return array(
			'fbc'    => $fbc,
			'fbp'    => isset( $a['fbp'] ) ? $a['fbp'] : null,
			'ttclid' => $param( 'ttclid' ),
			'ttp'    => isset( $a['ttp'] ) ? $a['ttp'] : null,
			'gclid'  => $param( 'gclid' ) ? $param( 'gclid' ) : $param( 'wbraid' ),
			'ga_cid' => isset( $a['ga_cid'] ) ? $a['ga_cid'] : null,
			'ip'     => isset( $a['ip'] ) ? $a['ip'] : null,
			'ua'     => isset( $a['user_agent'] ) ? $a['user_agent'] : null,
		);
	}

	private static function log( $order_number, $sent, $errors ) {
		$log   = get_option( self::LOG_OPT, array() );
		$log   = is_array( $log ) ? $log : array();
		$log[] = array(
			'at'     => gmdate( 'Y-m-d H:i:s' ),
			'order'  => (string) $order_number,
			'sent'   => $sent,
			'errors' => array_slice( $errors, 0, 3 ),
		);
		update_option( self::LOG_OPT, array_slice( $log, -40 ), false );
	}

	public static function recent( $limit = 20 ) {
		$log = get_option( self::LOG_OPT, array() );
		$log = is_array( $log ) ? array_reverse( $log ) : array();
		return array_slice( $log, 0, $limit );
	}
}
