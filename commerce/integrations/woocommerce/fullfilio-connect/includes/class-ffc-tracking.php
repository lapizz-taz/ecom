<?php
/**
 * Ad tracking: Meta (Pixel + Conversions API), TikTok (Pixel + Events API) and
 * Google (Ads gtag + GA4 Measurement Protocol / Enhanced Conversions).
 *
 * Browser and server, de-duplicated. Every funnel event (PageView, ViewContent,
 * AddToCart, InitiateCheckout) is fired by the browser pixel AND sent from the
 * server with the SAME event id, so an ad blocker or iOS loses nothing and the
 * platforms count it once. The Purchase uses one id per order (ffc_ord_<id>).
 *
 * When the Purchase counts is the merchant's choice:
 *   placed     the normal way: as soon as the order is placed
 *   confirmed  held until the call confirms it (status Confirmed)  — recommended for COD
 *   delivered  held until the parcel is delivered
 * and in every mode an order is NOT counted when the customer's courier
 * receive rate is low, or when the same customer already counted an order a
 * moment ago (a duplicate), so the ad platforms learn from real buyers.
 *
 * Matching: hashed email, phone (+880), name, city, district, postcode,
 * country and a first-party visitor id, plus fbc/fbp, ttclid/_ttp, gclid,
 * IP and browser — everything Meta counts towards Event Match Quality. The
 * score shown in the admin is our own estimate from the keys that were sent;
 * Meta's real score is in Events Manager.
 *
 * The merchant enters their own Pixel ids and API tokens (their own ad
 * accounts); tokens are never echoed back or sent to the browser.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Tracking {
	const OPTION     = 'ffc_tracking';
	const STATUS_OPT = 'ffc_track_status';
	const SEEN_OPT   = 'ffc_track_seen';
	const SENT       = '_ffc_track_sent';
	const SKIP       = '_ffc_track_skip';
	const RR_META    = '_ffc_receive_rate';
	const LOG_OPT    = 'ffc_track_log';
	const VID        = 'ffc_vid';
	const GRAPH      = 'https://graph.facebook.com/v22.0';
	const TIKTOK     = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
	const GA4_MP     = 'https://www.google-analytics.com/mp/collect';
	const GA4_DEBUG  = 'https://www.google-analytics.com/debug/mp/collect';
	const FUNNEL     = array( 'PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout' );
	const TRIGGERS   = array( 'placed', 'confirmed', 'delivered' );

	/** Our estimate of how much each Meta match key counts (sums to 10, like Event Match Quality). */
	const MQ_WEIGHTS = array(
		'em' => 2.0, 'ph' => 2.0, 'fbc' => 1.4, 'external_id' => 1.0, 'fbp' => 1.0, 'client_ip_address' => 0.5, 'client_user_agent' => 0.5,
		'fn' => 0.4, 'ln' => 0.4, 'ct' => 0.2, 'st' => 0.2, 'zp' => 0.1, 'country' => 0.3,
	);

	public static function defaults() {
		return array(
			'meta'              => array( 'on' => false, 'pixel' => '', 'token' => '', 'test' => '' ),
			'tiktok'            => array( 'on' => false, 'pixel' => '', 'token' => '', 'test' => '' ),
			'google'            => array( 'on' => false, 'conv_id' => '', 'conv_label' => '', 'ga4_id' => '', 'ga4_secret' => '' ),
			'trigger'           => 'confirmed', // placed | confirmed | delivered
			'exclude_low_rr'    => true,
			'min_rr'            => 40,          // orders below this receive-rate % are not counted
			'skip_duplicates'   => true,        // the same customer again within dup_hours is not counted twice
			'dup_hours'         => 24,
			'browser_events'    => true,        // funnel events from the browser pixels
			'server_events'     => true,        // the same funnel events from the server (Conversions API / Events API)
			'advanced_matching' => true,        // hashed customer data in the browser pixels too
			'browser_purchase'  => false,       // confirmed/delivered modes: also fire Purchase on the thank-you page
		);
	}

	const FLAGS = array( 'exclude_low_rr', 'skip_duplicates', 'browser_events', 'server_events', 'advanced_matching', 'browser_purchase' );

	public static function settings() {
		$saved = get_option( self::OPTION, array() );
		$out   = self::defaults();
		if ( is_array( $saved ) ) {
			foreach ( array( 'meta', 'tiktok', 'google' ) as $p ) {
				if ( isset( $saved[ $p ] ) && is_array( $saved[ $p ] ) ) {
					$out[ $p ] = array_merge( $out[ $p ], $saved[ $p ] );
				}
			}
			foreach ( array_merge( array( 'trigger', 'min_rr', 'dup_hours' ), self::FLAGS ) as $k ) {
				if ( array_key_exists( $k, $saved ) ) {
					$out[ $k ] = $saved[ $k ];
				}
			}
		}
		$out['trigger'] = in_array( $out['trigger'], self::TRIGGERS, true ) ? $out['trigger'] : 'confirmed';
		return $out;
	}

	/** Saves from the admin form. Tokens left blank keep the stored value; a *_clear flag removes them. */
	public static function save( $in ) {
		$cur = self::settings();
		$s   = self::defaults();
		foreach ( array( 'meta', 'tiktok' ) as $p ) {
			$s[ $p ]['on']    = ! empty( $in[ $p . '_on' ] );
			$s[ $p ]['pixel'] = isset( $in[ $p . '_pixel' ] ) ? substr( preg_replace( '/[^0-9A-Za-z_-]/', '', (string) $in[ $p . '_pixel' ] ), 0, 40 ) : '';
			$s[ $p ]['test']  = isset( $in[ $p . '_test' ] ) ? substr( preg_replace( '/[^0-9A-Za-z_]/', '', (string) $in[ $p . '_test' ] ), 0, 40 ) : '';
			$token            = isset( $in[ $p . '_token' ] ) ? substr( preg_replace( '/\s+/', '', (string) $in[ $p . '_token' ] ), 0, 600 ) : '';
			$s[ $p ]['token'] = ! empty( $in[ $p . '_token_clear' ] ) ? '' : ( '' !== $token ? $token : $cur[ $p ]['token'] );
		}
		$s['google']['on']         = ! empty( $in['google_on'] );
		$s['google']['conv_id']    = isset( $in['google_conv_id'] ) ? substr( preg_replace( '/[^0-9A-Za-z_-]/', '', (string) $in['google_conv_id'] ), 0, 40 ) : '';
		$s['google']['conv_label'] = isset( $in['google_conv_label'] ) ? substr( preg_replace( '/[^0-9A-Za-z_-]/', '', (string) $in['google_conv_label'] ), 0, 60 ) : '';
		$s['google']['ga4_id']     = isset( $in['google_ga4_id'] ) ? substr( preg_replace( '/[^0-9A-Za-z_-]/', '', (string) $in['google_ga4_id'] ), 0, 40 ) : '';
		$secret                    = isset( $in['google_ga4_secret'] ) ? substr( preg_replace( '/\s+/', '', (string) $in['google_ga4_secret'] ), 0, 200 ) : '';
		$s['google']['ga4_secret'] = ! empty( $in['google_ga4_secret_clear'] ) ? '' : ( '' !== $secret ? $secret : $cur['google']['ga4_secret'] );
		$s['trigger']   = isset( $in['trigger'] ) && in_array( $in['trigger'], self::TRIGGERS, true ) ? $in['trigger'] : 'confirmed';
		$s['min_rr']    = isset( $in['min_rr'] ) && '' !== $in['min_rr'] ? max( 0, min( 100, (int) $in['min_rr'] ) ) : 40;
		$s['dup_hours'] = isset( $in['dup_hours'] ) && '' !== $in['dup_hours'] ? max( 1, min( 168, (int) $in['dup_hours'] ) ) : 24;
		foreach ( self::FLAGS as $k ) {
			$s[ $k ] = ! empty( $in[ $k ] );
		}
		update_option( self::OPTION, $s, false );
	}

	public static function any_on() {
		$s = self::settings();
		return $s['meta']['on'] || $s['tiktok']['on'] || $s['google']['on'];
	}

	public static function init() {
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
		add_action( 'woocommerce_order_status_changed', array( __CLASS__, 'on_status' ), 30, 4 );
		// "When the order is placed": after FFC_Checkout has saved the click ids (priority 10).
		add_action( 'woocommerce_checkout_order_created', array( __CLASS__, 'on_placed' ), 50 );
		add_action( 'woocommerce_store_api_checkout_order_processed', array( __CLASS__, 'on_placed' ), 50 );
		add_action( 'wc_ajax_ffc_px', array( __CLASS__, 'beacon' ) );
	}

	// --- browser pixels ------------------------------------------------------------------------

	public static function enqueue() {
		if ( is_admin() || ! self::any_on() ) {
			return;
		}
		$s     = self::settings();
		$order = null;
		if ( function_exists( 'is_order_received_page' ) && is_order_received_page() ) {
			// phpcs:disable WordPress.Security.NonceVerification.Recommended -- display only; the order key is checked.
			$order_id = absint( get_query_var( 'order-received' ) );
			$order_id = $order_id ? $order_id : ( isset( $_GET['order-received'] ) ? absint( $_GET['order-received'] ) : 0 );
			$key      = isset( $_GET['key'] ) ? sanitize_text_field( wp_unslash( $_GET['key'] ) ) : '';
			// phpcs:enable
			$order = $order_id ? wc_get_order( $order_id ) : null;
			// Only the buyer who has the order key gets their own order's data on the page.
			$valid = $order instanceof WC_Order && ( ! method_exists( $order, 'key_is_valid' ) || $order->key_is_valid( $key ) );
			$order = $valid ? $order : null;
		}
		$page    = 'other';
		$product = null;
		$cart    = null;
		if ( function_exists( 'is_product' ) && is_product() ) {
			$page = 'product';
			$p    = function_exists( 'wc_get_product' ) ? wc_get_product( get_the_ID() ) : null;
			if ( $p ) {
				$product = self::product_data( $p, 1 );
			}
		} elseif ( function_exists( 'is_checkout' ) && is_checkout() && ! $order ) {
			$page = 'checkout';
			$cart = self::cart_data();
		} elseif ( function_exists( 'is_cart' ) && is_cart() ) {
			$page = 'cart';
		}

		// Thank-you page: the Purchase fires in the browser when it counts now (placed mode and
		// the order passed the rules), or when the merchant opted in for the other modes.
		$purchase = null;
		if ( $order instanceof WC_Order ) {
			$fire = 'placed' === $s['trigger'] ? 'send' === $order->get_meta( '_ffc_track_decision' ) : (bool) $s['browser_purchase'];
			if ( $fire ) {
				$purchase = array(
					'event_id' => self::event_id( $order ),
					'txn'      => (string) $order->get_order_number(),
					'value'    => round( (float) $order->get_total(), 2 ),
					'currency' => $order->get_currency(),
					'contents' => self::contents( $order ),
				);
			}
		}

		$cfg = array(
			'meta'     => $s['meta']['on'] && $s['meta']['pixel'] ? $s['meta']['pixel'] : '',
			'tiktok'   => $s['tiktok']['on'] && $s['tiktok']['pixel'] ? $s['tiktok']['pixel'] : '',
			'gads'     => $s['google']['on'] && $s['google']['conv_id'] ? $s['google']['conv_id'] : '',
			'gadsLabel' => $s['google']['on'] ? $s['google']['conv_label'] : '',
			'ga4'      => $s['google']['on'] && $s['google']['ga4_id'] ? $s['google']['ga4_id'] : '',
			'page'     => $page,
			'product'  => $product,
			'cart'     => $cart,
			'purchase' => $purchase,
			'funnel'   => (bool) $s['browser_events'],
			'server'   => $s['server_events'] && ( ( $s['meta']['on'] && $s['meta']['token'] ) || ( $s['tiktok']['on'] && $s['tiktok']['token'] ) ) && class_exists( 'WC_AJAX' ) ? WC_AJAX::get_endpoint( 'ffc_px' ) : '',
			'currency' => function_exists( 'get_woocommerce_currency' ) ? get_woocommerce_currency() : '',
			// Hashed customer data only for a signed-in customer or the buyer's own thank-you
			// page: those pages are never served from a page cache to someone else.
			'am'       => $s['advanced_matching'] ? self::browser_matching( $order ) : null,
		);
		if ( ! $cfg['meta'] && ! $cfg['tiktok'] && ! $cfg['gads'] && ! $cfg['ga4'] ) {
			return;
		}
		if ( ! $cfg['funnel'] && ! $cfg['purchase'] && ! $cfg['server'] ) {
			return;
		}
		wp_enqueue_script( 'ffc-track', FFC_URL . 'assets/ffc-track.js', array(), FFC_VERSION, true );
		wp_localize_script( 'ffc-track', 'ffcTrack', $cfg );
	}

	/** Hashed matching keys for the browser pixels (Meta/TikTok/Google naming handled in JS). */
	private static function browser_matching( $order ) {
		if ( $order instanceof WC_Order ) {
			$ud = self::user_data_from( self::order_person( $order ), array() );
		} elseif ( is_user_logged_in() && function_exists( 'WC' ) && isset( WC()->customer ) && is_object( WC()->customer ) ) {
			$c  = WC()->customer;
			$ud = self::user_data_from(
				array(
					'email' => $c->get_billing_email() ? $c->get_billing_email() : wp_get_current_user()->user_email,
					'phone' => $c->get_billing_phone(), 'first' => $c->get_billing_first_name(), 'last' => $c->get_billing_last_name(),
					'city' => $c->get_billing_city(), 'state' => $c->get_billing_state(), 'postcode' => $c->get_billing_postcode(), 'country' => $c->get_billing_country(),
				),
				array()
			);
		} else {
			return null;
		}
		$am = array_filter(
			array(
				'em' => $ud['email_h'], 'ph' => $ud['phone_h'], 'fn' => $ud['fn_h'], 'ln' => $ud['ln_h'], 'ct' => $ud['city_h'],
				'st' => $ud['state_h'], 'zp' => $ud['zip_h'], 'country' => $ud['country_h'], 'phE164' => $ud['phone_e164_h'],
			)
		);
		return $am ? $am : null;
	}

	private static function product_data( $p, $qty ) {
		return array(
			'id'       => (string) ( $p->get_sku() ? $p->get_sku() : $p->get_id() ),
			'pid'      => (int) $p->get_id(),
			'name'     => $p->get_name(),
			'price'    => round( (float) $p->get_price(), 2 ),
			'quantity' => max( 1, (int) $qty ),
			'currency' => function_exists( 'get_woocommerce_currency' ) ? get_woocommerce_currency() : '',
		);
	}

	private static function cart_data() {
		if ( ! function_exists( 'WC' ) || ! isset( WC()->cart ) || ! is_object( WC()->cart ) ) {
			return null;
		}
		$contents = array();
		foreach ( WC()->cart->get_cart() as $line ) {
			$p = isset( $line['data'] ) && is_object( $line['data'] ) ? $line['data'] : null;
			if ( $p ) {
				$contents[] = array( 'id' => (string) ( $p->get_sku() ? $p->get_sku() : $p->get_id() ), 'name' => $p->get_name(), 'quantity' => (int) $line['quantity'], 'item_price' => round( (float) $p->get_price(), 2 ) );
			}
		}
		return array(
			'value'    => round( (float) WC()->cart->get_total( 'edit' ), 2 ),
			'currency' => function_exists( 'get_woocommerce_currency' ) ? get_woocommerce_currency() : '',
			'contents' => array_slice( $contents, 0, 50 ),
		);
	}

	// --- server copy of the funnel events (same event id as the browser) ----------------------

	/** wc-ajax=ffc_px: the browser tells us which funnel event it fired; we send the server copy. */
	public static function beacon() {
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- public, rate limited, sends only the visitor's own event; works with page caching.
		$s  = self::settings();
		$ev = isset( $_POST['ev'] ) ? sanitize_text_field( wp_unslash( $_POST['ev'] ) ) : '';
		$id = isset( $_POST['id'] ) ? sanitize_text_field( wp_unslash( $_POST['id'] ) ) : '';
		if ( ! self::any_on() || ! $s['server_events'] || ! in_array( $ev, self::FUNNEL, true ) || ! preg_match( '/^[A-Za-z0-9_.-]{8,64}$/', $id ) ) {
			self::beacon_reply( false );
		}
		$ip = class_exists( 'WC_Geolocation' ) ? WC_Geolocation::get_ip_address() : ( isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '' );
		// Limits: a site-wide cap per minute (one reused row, so spoofed IPs cannot fill the
		// database) and, with a persistent object cache, 60 events per visitor IP per 5 minutes.
		// Meta and TikTok drop a repeated event id themselves.
		$bucket = 'ffc_px_' . gmdate( 'YmdHi' );
		$n      = (int) get_transient( $bucket );
		if ( $n >= (int) apply_filters( 'ffc_server_events_per_minute', 600 ) ) {
			self::beacon_reply( false );
		}
		set_transient( $bucket, $n + 1, 2 * MINUTE_IN_SECONDS );
		if ( wp_using_ext_object_cache() ) {
			$ik = 'ip_' . md5( (string) $ip );
			wp_cache_add( $ik, 0, 'ffc_px', 5 * MINUTE_IN_SECONDS );
			if ( (int) wp_cache_incr( $ik, 1, 'ffc_px' ) > 60 ) {
				self::beacon_reply( false );
			}
		}

		// The page must be on this store.
		$url  = isset( $_POST['url'] ) ? esc_url_raw( wp_unslash( $_POST['url'] ) ) : '';
		$home = wp_parse_url( home_url(), PHP_URL_HOST );
		if ( '' === $url || wp_parse_url( $url, PHP_URL_HOST ) !== $home ) {
			$url = home_url( '/' );
		}
		// Product and value come from the store, never from the browser.
		$custom = array();
		if ( in_array( $ev, array( 'ViewContent', 'AddToCart' ), true ) ) {
			$pid = isset( $_POST['pid'] ) ? absint( $_POST['pid'] ) : 0;
			$qty = isset( $_POST['qty'] ) ? max( 1, min( 99, absint( $_POST['qty'] ) ) ) : 1;
			$p   = $pid && function_exists( 'wc_get_product' ) ? wc_get_product( $pid ) : null;
			if ( ! $p ) {
				self::beacon_reply( false );
			}
			$d      = self::product_data( $p, $qty );
			$custom = array( 'currency' => $d['currency'], 'value' => round( $d['price'] * $qty, 2 ), 'content_type' => 'product', 'content_ids' => array( $d['id'] ), 'content_name' => $d['name'], 'contents' => array( array( 'id' => $d['id'], 'quantity' => $qty, 'item_price' => $d['price'] ) ) );
		} elseif ( 'InitiateCheckout' === $ev ) {
			$c = self::cart_data();
			if ( $c ) {
				$custom = array( 'currency' => $c['currency'], 'value' => $c['value'], 'content_type' => 'product', 'content_ids' => wp_list_pluck( $c['contents'], 'id' ), 'contents' => array_map( static function ( $x ) { return array( 'id' => $x['id'], 'quantity' => $x['quantity'], 'item_price' => $x['item_price'] ); }, $c['contents'] ), 'num_items' => array_sum( wp_list_pluck( $c['contents'], 'quantity' ) ) );
			}
		}
		// phpcs:enable

		$attr = self::live_attribution( $ip );
		$ud   = self::user_data_from( self::visitor_person(), $attr );
		$jobs = array();
		if ( $s['meta']['on'] && $s['meta']['pixel'] && $s['meta']['token'] ) {
			$jobs[] = 'meta';
		}
		if ( $s['tiktok']['on'] && $s['tiktok']['pixel'] && $s['tiktok']['token'] && 'PageView' !== $ev ) {
			$jobs[] = 'tiktok';
		}
		self::beacon_reply( true, false );
		foreach ( $jobs as $job ) {
			$r = 'meta' === $job
				? self::meta_event( $s['meta'], $ev, $id, $url, self::meta_user( $ud, $attr ), $custom, time() )
				: self::tiktok_event( $s['tiktok'], $ev, $id, $url, self::tiktok_user( $ud, $attr ), self::tiktok_props( $custom ), time() );
			self::remember_status( $job, $r, 'event' );
		}
		exit;
	}

	/** Answers the browser at once; the server copy is sent after the visitor got the reply. */
	private static function beacon_reply( $ok, $stop = true ) {
		if ( ! headers_sent() ) {
			status_header( 200 );
			header( 'Content-Type: application/json; charset=utf-8' );
			header( 'Cache-Control: no-store' );
		}
		echo $ok ? '{"ok":true}' : '{"ok":false}';
		if ( $stop ) {
			exit;
		}
		if ( function_exists( 'fastcgi_finish_request' ) ) {
			fastcgi_finish_request();
		} elseif ( function_exists( 'litespeed_finish_request' ) ) {
			litespeed_finish_request();
		} else {
			ignore_user_abort( true );
			if ( ob_get_level() ) {
				ob_end_flush();
			}
			flush();
		}
	}

	// --- the Purchase ----------------------------------------------------------------------------

	/** Statuses that count for each trigger mode. */
	private static function trigger_statuses( $trigger ) {
		if ( 'delivered' === $trigger ) {
			return array( 'delivered', 'partial-delivered', 'completed' );
		}
		return 'placed' === $trigger ? array() : array( 'confirmed' );
	}

	public static function on_placed( $order ) {
		if ( ! $order instanceof WC_Order || ! self::any_on() ) {
			return;
		}
		$s = self::settings();
		if ( 'placed' === $s['trigger'] ) {
			self::maybe_send( $order, $s );
		}
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
		// Early signal from the order shield: an advance asked / blocked = low delivery success.
		$shield = (string) $order->get_meta( '_ffc_shield' );
		if ( 'advance' === $shield || 'block' === $shield ) {
			return 0.0;
		}
		return null;
	}

	/** One key per customer for the duplicate check: the phone (+880 form), else the email. */
	private static function customer_key( $order ) {
		$phone = self::phone_digits( $order->get_billing_phone() );
		if ( strlen( $phone ) >= 10 ) {
			return 'p' . substr( hash( 'sha256', $phone ), 0, 24 );
		}
		$email = strtolower( trim( (string) $order->get_billing_email() ) );
		return '' !== $email ? 'e' . substr( hash( 'sha256', $email ), 0, 24 ) : '';
	}

	/** Why this order is not counted, or '' when it is. */
	private static function skip_reason( $order, $s ) {
		if ( $order->get_total() <= 0 ) {
			return 'Order value is 0';
		}
		if ( $s['exclude_low_rr'] ) {
			$rr = self::receive_rate( $order );
			if ( null !== $rr && $rr < (float) $s['min_rr'] ) {
				return sprintf( 'Low receive rate: %s%% (below %d%%)', rtrim( rtrim( number_format( $rr, 1, '.', '' ), '0' ), '.' ), (int) $s['min_rr'] );
			}
		}
		if ( $s['skip_duplicates'] ) {
			$key  = self::customer_key( $order );
			$seen = get_option( self::SEEN_OPT, array() );
			if ( '' !== $key && is_array( $seen ) && isset( $seen[ $key ] ) && (int) $seen[ $key ][1] !== (int) $order->get_id() && (int) $seen[ $key ][0] > time() - (int) $s['dup_hours'] * HOUR_IN_SECONDS ) {
				return sprintf( 'Duplicate: the same customer\'s order #%s was counted within %dh', $seen[ $key ][2], (int) $s['dup_hours'] );
			}
		}
		return '';
	}

	private static function remember_customer( $order ) {
		$key = self::customer_key( $order );
		if ( '' === $key ) {
			return;
		}
		$seen = get_option( self::SEEN_OPT, array() );
		$seen = is_array( $seen ) ? $seen : array();
		$cut  = time() - 8 * DAY_IN_SECONDS;
		$seen = array_filter( $seen, static function ( $v ) use ( $cut ) { return is_array( $v ) && (int) $v[0] > $cut; } );
		$seen[ $key ] = array( time(), (int) $order->get_id(), (string) $order->get_order_number() );
		if ( count( $seen ) > 3000 ) {
			uasort( $seen, static function ( $a, $b ) { return $b[0] - $a[0]; } );
			$seen = array_slice( $seen, 0, 3000, true );
		}
		update_option( self::SEEN_OPT, $seen, false );
	}

	public static function maybe_send( $order, $s = null ) {
		$s = $s ? $s : self::settings();
		if ( $order->get_meta( self::SENT ) ) {
			return; // counted once per order
		}
		$why = self::skip_reason( $order, $s );
		if ( '' !== $why ) {
			if ( $order->get_meta( self::SKIP ) !== $why ) {
				$order->update_meta_data( self::SKIP, $why );
				$order->update_meta_data( '_ffc_track_decision', 'skip' );
				$order->save_meta_data();
				self::log( $order->get_order_number(), array(), array(), $why, null );
			}
			return;
		}
		$order->update_meta_data( '_ffc_track_decision', 'send' );
		$attr   = self::attribution( $order );
		$ud     = self::user_data_from( self::order_person( $order ), $attr );
		$sent   = array();
		$errors = array();
		$mq     = null;
		$url    = $attr['page'] ? $attr['page'] : $order->get_checkout_order_received_url();
		// Within Meta's 7-day window the Purchase keeps the time the order was placed.
		$placed = $order->get_date_created() ? $order->get_date_created()->getTimestamp() : time();
		$when   = $placed > time() - 6 * DAY_IN_SECONDS ? min( time(), $placed ) : time();
		if ( $s['meta']['on'] && $s['meta']['pixel'] && $s['meta']['token'] ) {
			$user = self::meta_user( $ud, $attr );
			$mq   = self::match_quality( $user );
			$r    = self::meta_event( $s['meta'], 'Purchase', self::event_id( $order ), $url, $user, self::purchase_custom( $order ), $when );
			self::remember_status( 'meta', $r, 'purchase' );
			$r['ok'] ? $sent[] = 'Meta' : $errors[] = 'Meta: ' . $r['error'];
		}
		if ( $s['tiktok']['on'] && $s['tiktok']['pixel'] && $s['tiktok']['token'] ) {
			$r = self::tiktok_event( $s['tiktok'], 'CompletePayment', self::event_id( $order ), $url, self::tiktok_user( $ud, $attr ), self::tiktok_props( self::purchase_custom( $order ) ), $when );
			self::remember_status( 'tiktok', $r, 'purchase' );
			$r['ok'] ? $sent[] = 'TikTok' : $errors[] = 'TikTok: ' . $r['error'];
		}
		if ( $s['google']['on'] && $s['google']['ga4_id'] && $s['google']['ga4_secret'] ) {
			$r = self::post( self::ga4_url( self::GA4_MP, $s['google'] ), self::google_payload( $order, $ud, $attr ) );
			self::remember_status( 'google', $r, 'purchase' );
			$r['ok'] ? $sent[] = 'Google' : $errors[] = 'Google: ' . $r['error'];
		}
		if ( $sent ) {
			$order->update_meta_data( self::SENT, gmdate( 'c' ) . ' → ' . implode( ', ', $sent ) );
			if ( $order->get_meta( self::SKIP ) ) {
				$order->update_meta_data( self::SKIP, '' );
			}
			self::remember_customer( $order );
		}
		$order->save_meta_data();
		self::log( $order->get_order_number(), $sent, $errors, '', $mq );
		if ( $errors ) {
			FFC_Log::warning( 'Tracking send issues for #' . $order->get_order_number() . ': ' . implode( ' | ', $errors ) );
		}
	}

	// --- per-platform payloads ---------------------------------------------------------------------

	private static function meta_user( $ud, $attr ) {
		return array_filter(
			array(
				'em'                => $ud['email_h'] ? array( $ud['email_h'] ) : null,
				'ph'                => $ud['phone_h'] ? array( $ud['phone_h'] ) : null,
				'fn'                => $ud['fn_h'] ? array( $ud['fn_h'] ) : null,
				'ln'                => $ud['ln_h'] ? array( $ud['ln_h'] ) : null,
				'ct'                => $ud['city_h'] ? array( $ud['city_h'] ) : null,
				'st'                => $ud['state_h'] ? array( $ud['state_h'] ) : null,
				'zp'                => $ud['zip_h'] ? array( $ud['zip_h'] ) : null,
				'country'           => $ud['country_h'] ? array( $ud['country_h'] ) : null,
				'external_id'       => $ud['external_h'] ? $ud['external_h'] : null,
				'client_ip_address' => $attr['ip'],
				'client_user_agent' => $attr['ua'],
				'fbc'               => $attr['fbc'],
				'fbp'               => $attr['fbp'],
			)
		);
	}

	private static function meta_event( $cfg, $name, $event_id, $url, $user, $custom, $when ) {
		$data = array(
			'event_name'       => $name,
			'event_time'       => (int) $when,
			'event_id'         => $event_id,
			'action_source'    => 'website',
			'event_source_url' => $url,
			'user_data'        => (object) $user,
		);
		if ( $custom ) {
			$data['custom_data'] = $custom;
		}
		$body = array( 'data' => array( $data ), 'access_token' => $cfg['token'] );
		if ( ! empty( $cfg['test'] ) ) {
			$body['test_event_code'] = $cfg['test'];
		}
		return self::post( self::GRAPH . '/' . rawurlencode( $cfg['pixel'] ) . '/events', $body );
	}

	private static function tiktok_user( $ud, $attr ) {
		return array_filter(
			array(
				'email'       => $ud['email_h'],
				'phone'       => $ud['phone_e164_h'], // TikTok: E.164 with '+', then SHA-256
				'external_id' => $ud['external_h'] ? $ud['external_h'][0] : null,
				'ttclid'      => $attr['ttclid'],
				'ttp'         => $attr['ttp'],
				'ip'          => $attr['ip'],
				'user_agent'  => $attr['ua'],
			)
		);
	}

	private static function tiktok_props( $custom ) {
		if ( ! $custom ) {
			return array();
		}
		$out = array( 'currency' => isset( $custom['currency'] ) ? $custom['currency'] : '', 'value' => isset( $custom['value'] ) ? $custom['value'] : 0, 'content_type' => 'product' );
		if ( ! empty( $custom['contents'] ) ) {
			$out['contents'] = array_map(
				static function ( $c ) {
					return array_filter( array( 'content_id' => $c['id'], 'content_name' => isset( $c['name'] ) ? $c['name'] : null, 'quantity' => $c['quantity'], 'price' => $c['item_price'] ) );
				},
				$custom['contents']
			);
		}
		return $out;
	}

	private static function tiktok_event( $cfg, $name, $event_id, $url, $user, $props, $when ) {
		$payload = array(
			'event_source'    => 'web',
			'event_source_id' => $cfg['pixel'],
			'data'            => array(
				array_filter(
					array(
						'event'      => $name,
						'event_time' => (int) $when,
						'event_id'   => $event_id,
						'user'       => (object) $user,
						'properties' => $props ? $props : null,
						'page'       => array( 'url' => $url ),
					)
				),
			),
		);
		if ( ! empty( $cfg['test'] ) ) {
			$payload['test_event_code'] = $cfg['test'];
		}
		return self::post( self::TIKTOK, $payload, array( 'Access-Token' => $cfg['token'] ) );
	}

	private static function purchase_custom( $order ) {
		$contents = self::contents( $order );
		return array(
			'currency'     => $order->get_currency(),
			'value'        => round( (float) $order->get_total(), 2 ),
			'content_type' => 'product',
			'contents'     => $contents,
			'content_ids'  => wp_list_pluck( $contents, 'id' ),
			'num_items'    => $order->get_item_count(),
			'order_id'     => (string) $order->get_order_number(),
		);
	}

	private static function google_payload( $order, $ud, $attr ) {
		$items = array();
		foreach ( self::contents( $order ) as $c ) {
			$items[] = array( 'item_id' => $c['id'], 'item_name' => $c['name'], 'quantity' => $c['quantity'], 'price' => $c['item_price'] );
		}
		$address = array_filter(
			array(
				'sha256_first_name' => $ud['fn_h'],
				'sha256_last_name'  => $ud['ln_h'],
				'city'              => $ud['city'],
				'region'            => $ud['state'],
				'postal_code'       => $ud['zip'],
				'country'           => $ud['country'] ? strtoupper( $ud['country'] ) : null,
			)
		);
		$out = array(
			// The browser's GA client id joins the server purchase to the visit; else a stable id per order.
			'client_id'            => $attr['ga_cid'] ? $attr['ga_cid'] : ( 1000000000 + crc32( self::event_id( $order ) ) % 1000000000 ) . '.' . $order->get_id(),
			'non_personalized_ads' => false,
			'user_data'            => array_filter(
				array(
					'sha256_email_address' => $ud['email_h'] ? array( $ud['email_h'] ) : null,
					'sha256_phone_number'  => $ud['phone_e164_h'] ? array( $ud['phone_e164_h'] ) : null,
					'address'              => $address ? array( $address ) : null,
				)
			),
			'events'               => array(
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
		if ( $ud['external_h'] ) {
			$out['user_id'] = $ud['external_h'][0];
		}
		return $out;
	}

	private static function ga4_url( $base, $cfg ) {
		return add_query_arg( array( 'measurement_id' => rawurlencode( $cfg['ga4_id'] ), 'api_secret' => rawurlencode( $cfg['ga4_secret'] ) ), $base );
	}

	/** One POST to a fixed ad-platform host. */
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
		return self::answer( $res );
	}

	private static function answer( $res ) {
		if ( is_wp_error( $res ) ) {
			return array( 'ok' => false, 'error' => $res->get_error_message(), 'json' => null );
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		$json = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		if ( $code >= 200 && $code < 300 ) {
			// GA4 returns 204 with no body; Meta/TikTok return JSON. TikTok uses code:0 for success.
			if ( is_array( $json ) && isset( $json['code'] ) && 0 !== (int) $json['code'] ) {
				return array( 'ok' => false, 'error' => isset( $json['message'] ) ? (string) $json['message'] : 'rejected', 'json' => $json );
			}
			return array( 'ok' => true, 'error' => '', 'json' => $json );
		}
		$msg = is_array( $json ) && isset( $json['error']['message'] ) ? (string) $json['error']['message'] : ( is_array( $json ) && isset( $json['message'] ) ? (string) $json['message'] : 'HTTP ' . $code );
		return array( 'ok' => false, 'error' => $msg, 'json' => $json );
	}

	// --- connection checks -------------------------------------------------------------------------

	/**
	 * Checks one platform with the saved ids and token.
	 *
	 * @return array{ok:bool,message:string}
	 */
	public static function test( $platform ) {
		$s = self::settings();
		if ( 'meta' === $platform ) {
			$c = $s['meta'];
			if ( ! $c['pixel'] || ! $c['token'] ) {
				return self::tested( 'meta', false, 'Enter the Pixel ID and the Conversions API token first.', true );
			}
			// Reading the pixel with the token proves the token can send to it; nothing is counted.
			$r = self::answer( wp_remote_get( self::GRAPH . '/' . rawurlencode( $c['pixel'] ) . '?fields=id,name', array( 'timeout' => 12, 'redirection' => 0, 'headers' => array( 'Authorization' => 'Bearer ' . $c['token'] ) ) ) );
			if ( ! $r['ok'] || ! is_array( $r['json'] ) || (string) ( isset( $r['json']['id'] ) ? $r['json']['id'] : '' ) !== (string) $c['pixel'] ) {
				return self::tested( 'meta', false, 'Meta refused: ' . ( $r['error'] ? $r['error'] : 'the token cannot use this pixel' ) );
			}
			$msg = 'Connected to pixel “' . ( isset( $r['json']['name'] ) ? $r['json']['name'] : $c['pixel'] ) . '”.';
			if ( $c['test'] ) {
				$t   = self::meta_event( $c, 'PageView', 'ffc_test_' . wp_generate_password( 10, false ), home_url( '/' ), array( 'client_user_agent' => 'Fullfilio connection test', 'external_id' => array( hash( 'sha256', 'ffc-test' ) ) ), array(), time() );
				$msg .= $t['ok'] ? ' A test PageView was sent — see Events Manager → Test events.' : ' The test event was refused: ' . $t['error'];
			}
			return self::tested( 'meta', true, $msg );
		}
		if ( 'tiktok' === $platform ) {
			$c = $s['tiktok'];
			if ( ! $c['pixel'] || ! $c['token'] ) {
				return self::tested( 'tiktok', false, 'Enter the Pixel ID and the Events API token first.', true );
			}
			if ( ! $c['test'] ) {
				return self::tested( 'tiktok', false, 'Add a test event code (TikTok Events Manager → your pixel → Test events) so the check does not count a real event.', true );
			}
			$r = self::tiktok_event( $c, 'ViewContent', 'ffc_test_' . wp_generate_password( 10, false ), home_url( '/' ), array( 'external_id' => hash( 'sha256', 'ffc-test' ), 'user_agent' => 'Fullfilio connection test' ), array(), time() );
			return self::tested( 'tiktok', $r['ok'], $r['ok'] ? 'TikTok accepted a test event — see Events Manager → Test events.' : 'TikTok refused: ' . $r['error'] );
		}
		if ( 'google' === $platform ) {
			$c = $s['google'];
			if ( ! $c['ga4_id'] || ! $c['ga4_secret'] ) {
				return self::tested( 'google', false, 'Enter the GA4 Measurement ID and the Measurement Protocol API secret first.', true );
			}
			$payload = array( 'client_id' => '123456789.1700000000', 'events' => array( array( 'name' => 'purchase', 'params' => array( 'transaction_id' => 'ffc-test', 'value' => 1, 'currency' => 'BDT' ) ) ) );
			$r       = self::post( self::ga4_url( self::GA4_DEBUG, $c ), $payload );
			$issues  = is_array( $r['json'] ) && ! empty( $r['json']['validationMessages'] ) ? wp_list_pluck( $r['json']['validationMessages'], 'description' ) : array();
			if ( ! $r['ok'] || $issues ) {
				return self::tested( 'google', false, 'Google refused: ' . ( $issues ? implode( ' ', $issues ) : $r['error'] ) );
			}
			return self::tested( 'google', true, 'Google\'s validation server accepted the purchase format. Google does not check the API secret there — the first real purchase shows in GA4 → Reports → Realtime.' );
		}
		return array( 'ok' => false, 'message' => 'Unknown platform.' );
	}

	/** $hint: nothing was checked yet (an id, token or test code is missing) — not a failure. */
	private static function tested( $platform, $ok, $message, $hint = false ) {
		self::remember_status( $platform, array( 'ok' => $ok, 'error' => $ok ? '' : $message ), $hint ? 'hint' : 'test', $message );
		return array( 'ok' => $ok, 'message' => $message, 'hint' => $hint );
	}

	/** Last result per platform, shown on its card. */
	private static function remember_status( $platform, $r, $kind, $message = '' ) {
		$all = get_option( self::STATUS_OPT, array() );
		$all = is_array( $all ) ? $all : array();
		$all[ $platform ] = array( 'ok' => (bool) $r['ok'], 'message' => $message ? $message : ( $r['ok'] ? '' : (string) $r['error'] ), 'kind' => $kind, 'at' => gmdate( 'Y-m-d H:i:s' ) );
		update_option( self::STATUS_OPT, $all, false );
	}

	public static function status( $platform ) {
		$all = get_option( self::STATUS_OPT, array() );
		return is_array( $all ) && isset( $all[ $platform ] ) ? $all[ $platform ] : null;
	}

	// --- helpers -----------------------------------------------------------------------------

	/** One stable event id per order so a browser Pixel and the server event de-duplicate. */
	public static function event_id( $order ) {
		return 'ffc_ord_' . $order->get_id();
	}

	private static function h( $value ) {
		$value = trim( function_exists( 'mb_strtolower' ) ? mb_strtolower( (string) $value, 'UTF-8' ) : strtolower( (string) $value ) );
		return '' === $value ? null : hash( 'sha256', $value );
	}

	/** Bangladesh numbers as 8801XXXXXXXXX; other numbers keep their digits. */
	public static function phone_digits( $phone ) {
		$d = preg_replace( '/\D/', '', (string) $phone );
		if ( 11 === strlen( $d ) && 0 === strpos( $d, '01' ) ) {
			$d = '88' . $d;
		} elseif ( 10 === strlen( $d ) && 0 === strpos( $d, '1' ) ) {
			$d = '880' . $d;
		} elseif ( 0 === strpos( $d, '00' ) ) {
			$d = substr( $d, 2 );
		}
		return $d;
	}

	/** Letters only, lower case (Meta's rule for city/state; keeps Bangla letters). */
	private static function letters( $value ) {
		$v = function_exists( 'mb_strtolower' ) ? mb_strtolower( (string) $value, 'UTF-8' ) : strtolower( (string) $value );
		$v = preg_replace( '/[^\p{L}]/u', '', $v );
		return null === $v ? '' : $v;
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

	private static function order_person( $order ) {
		return array(
			'email' => $order->get_billing_email(), 'phone' => $order->get_billing_phone() ? $order->get_billing_phone() : ( method_exists( $order, 'get_shipping_phone' ) ? $order->get_shipping_phone() : '' ),
			'first' => $order->get_billing_first_name(), 'last' => $order->get_billing_last_name(), 'city' => $order->get_billing_city(),
			'state' => method_exists( $order, 'get_billing_state' ) ? $order->get_billing_state() : '', 'postcode' => method_exists( $order, 'get_billing_postcode' ) ? $order->get_billing_postcode() : '',
			'country' => $order->get_billing_country(), 'customer_id' => $order->get_customer_id(),
		);
	}

	/** What the store knows about the visitor right now (signed-in customer or checkout session). */
	private static function visitor_person() {
		$c = function_exists( 'WC' ) && isset( WC()->customer ) && is_object( WC()->customer ) ? WC()->customer : null;
		if ( ! $c || ! method_exists( $c, 'get_billing_email' ) ) {
			return array( 'customer_id' => get_current_user_id() );
		}
		return array(
			'email' => $c->get_billing_email() ? $c->get_billing_email() : ( is_user_logged_in() ? wp_get_current_user()->user_email : '' ),
			'phone' => $c->get_billing_phone(), 'first' => $c->get_billing_first_name(), 'last' => $c->get_billing_last_name(),
			'city' => $c->get_billing_city(), 'state' => $c->get_billing_state(), 'postcode' => $c->get_billing_postcode(), 'country' => $c->get_billing_country(),
			'customer_id' => get_current_user_id(),
		);
	}

	/** Normalised + hashed matching keys (each platform's own format). */
	private static function user_data_from( $p, $attr ) {
		$get     = static function ( $k ) use ( $p ) { return isset( $p[ $k ] ) ? (string) $p[ $k ] : ''; };
		$phone   = self::phone_digits( $get( 'phone' ) );
		$country = strtolower( substr( preg_replace( '/[^A-Za-z]/', '', $get( 'country' ) ), 0, 2 ) );
		if ( '' === $country && 0 === strpos( $phone, '880' ) ) {
			$country = 'bd';
		}
		// WooCommerce stores a district code (BD-13); Meta wants the name, lower case, letters only.
		$state = $get( 'state' );
		if ( '' !== $state && '' !== $country && function_exists( 'WC' ) && isset( WC()->countries ) && is_object( WC()->countries ) ) {
			$states = WC()->countries->get_states( strtoupper( $country ) );
			if ( is_array( $states ) && isset( $states[ $state ] ) ) {
				$state = $states[ $state ];
			}
		}
		$city  = self::letters( $get( 'city' ) );
		$state = self::letters( $state );
		$zip   = strtolower( preg_replace( '/\s+/', '', $get( 'postcode' ) ) );
		$ext   = array();
		if ( ! empty( $attr['vid'] ) ) {
			$ext[] = hash( 'sha256', strtolower( (string) $attr['vid'] ) ); // the same visitor id the browser pixels use
		}
		if ( (int) $get( 'customer_id' ) > 0 ) {
			$ext[] = hash( 'sha256', 'wc_' . (int) $get( 'customer_id' ) );
		}
		return array(
			'email_h'      => is_email( trim( $get( 'email' ) ) ) ? self::h( $get( 'email' ) ) : null,
			'phone_h'      => strlen( $phone ) >= 10 ? hash( 'sha256', $phone ) : null,       // Meta: digits with country code
			'phone_e164_h' => strlen( $phone ) >= 10 ? hash( 'sha256', '+' . $phone ) : null, // Google/TikTok: E.164 with '+'
			'fn_h'         => self::h( $get( 'first' ) ),
			'ln_h'         => self::h( $get( 'last' ) ),
			'city_h'       => '' !== $city ? hash( 'sha256', $city ) : null,
			'state_h'      => '' !== $state ? hash( 'sha256', $state ) : null,
			'zip_h'        => '' !== $zip ? hash( 'sha256', $zip ) : null,
			'country_h'    => '' !== $country ? hash( 'sha256', $country ) : null,
			'external_h'   => $ext ? $ext : null,
			'city'         => '' !== $city ? $city : null,
			'state'        => '' !== $state ? $state : null,
			'zip'          => '' !== $zip ? $zip : null,
			'country'      => '' !== $country ? $country : null,
		);
	}

	/** Our estimate (0-10) from the keys sent; Meta's real Event Match Quality is in Events Manager. */
	public static function match_quality( $user ) {
		$score = 0.0;
		foreach ( self::MQ_WEIGHTS as $k => $w ) {
			if ( ! empty( $user[ $k ] ) ) {
				$score += $w;
			}
		}
		return array( 'score' => round( min( 10, $score ), 1 ), 'keys' => array_values( array_intersect( array_keys( self::MQ_WEIGHTS ), array_keys( array_filter( $user ) ) ) ) );
	}

	/** Click ids and cookies saved on the order by FFC_Checkout. */
	private static function attribution( $order ) {
		$raw   = $order->get_meta( '_ffc_attribution' );
		$a     = $raw ? json_decode( (string) $raw, true ) : array();
		$a     = is_array( $a ) ? $a : array();
		$last  = isset( $a['last_touch']['params'] ) && is_array( $a['last_touch']['params'] ) ? $a['last_touch']['params'] : array();
		$first = isset( $a['first_touch']['params'] ) && is_array( $a['first_touch']['params'] ) ? $a['first_touch']['params'] : array();
		$param = static function ( $key ) use ( $last, $first ) {
			if ( ! empty( $last[ $key ] ) ) {
				return (string) $last[ $key ];
			}
			return ! empty( $first[ $key ] ) ? (string) $first[ $key ] : null;
		};
		$fbc = isset( $a['fbc'] ) ? $a['fbc'] : null;
		if ( ! $fbc && $param( 'fbclid' ) ) {
			// Rebuild the fbc click cookie from the fbclid when the cookie was not captured; the
			// creation time is when the visitor landed, not now.
			$at  = isset( $a['last_touch']['at'] ) ? strtotime( (string) $a['last_touch']['at'] ) : false;
			$fbc = 'fb.1.' . ( ( $at ? $at : time() ) * 1000 ) . '.' . $param( 'fbclid' );
		}
		return array(
			'fbc'    => $fbc,
			'fbp'    => isset( $a['fbp'] ) ? $a['fbp'] : null,
			'ttclid' => $param( 'ttclid' ),
			'ttp'    => isset( $a['ttp'] ) ? $a['ttp'] : null,
			'gclid'  => $param( 'gclid' ) ? $param( 'gclid' ) : $param( 'wbraid' ),
			'ga_cid' => isset( $a['ga_cid'] ) ? $a['ga_cid'] : null,
			'vid'    => isset( $a['vid'] ) ? $a['vid'] : null,
			'ip'     => isset( $a['ip'] ) ? $a['ip'] : null,
			'ua'     => isset( $a['user_agent'] ) ? $a['user_agent'] : null,
			'page'   => isset( $a['checkout_url'] ) ? $a['checkout_url'] : null,
		);
	}

	/** The same keys read live from this request's cookies (server copy of a funnel event). */
	private static function live_attribution( $ip ) {
		$cookie = static function ( $name ) {
			return isset( $_COOKIE[ $name ] ) ? substr( sanitize_text_field( wp_unslash( $_COOKIE[ $name ] ) ), 0, 200 ) : null;
		};
		$raw    = isset( $_COOKIE['ffc_attr'] ) ? json_decode( (string) wp_unslash( $_COOKIE['ffc_attr'] ), true ) : null; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- only two ids are read and cleaned.
		$params = is_array( $raw ) && isset( $raw['last']['params'] ) && is_array( $raw['last']['params'] ) ? $raw['last']['params'] : array();
		$clean  = static function ( $v ) { return null === $v ? null : substr( preg_replace( '/[^A-Za-z0-9_.-]/', '', (string) $v ), 0, 200 ); };
		$vid    = $cookie( self::VID );
		return array(
			'fbc'    => $cookie( '_fbc' ),
			'fbp'    => $cookie( '_fbp' ),
			'ttclid' => isset( $params['ttclid'] ) ? $clean( $params['ttclid'] ) : null,
			'ttp'    => $cookie( '_ttp' ),
			'gclid'  => null,
			'ga_cid' => null,
			'vid'    => $vid && preg_match( '/^[A-Za-z0-9]{12,40}$/', $vid ) ? $vid : null,
			'ip'     => $ip ? $ip : null,
			'ua'     => isset( $_SERVER['HTTP_USER_AGENT'] ) ? substr( sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ), 0, 300 ) : null,
			'page'   => null,
		);
	}

	private static function log( $order_number, $sent, $errors, $skipped = '', $mq = null ) {
		$log   = get_option( self::LOG_OPT, array() );
		$log   = is_array( $log ) ? $log : array();
		$log[] = array(
			'at'      => gmdate( 'Y-m-d H:i:s' ),
			'order'   => (string) $order_number,
			'sent'    => $sent,
			'errors'  => array_slice( $errors, 0, 3 ),
			'skipped' => (string) $skipped,
			'mq'      => $mq,
		);
		update_option( self::LOG_OPT, array_slice( $log, -60 ), false );
	}

	public static function recent( $limit = 20 ) {
		$log = get_option( self::LOG_OPT, array() );
		$log = is_array( $log ) ? array_reverse( $log ) : array();
		return array_slice( $log, 0, $limit );
	}

	/** Average estimated match quality and how often each key was present, over the recent Purchases. */
	public static function match_summary() {
		$rows = array_filter( self::recent( 60 ), static function ( $r ) { return ! empty( $r['mq'] ) && is_array( $r['mq'] ); } );
		if ( ! $rows ) {
			return null;
		}
		$n    = count( $rows );
		$sum  = 0.0;
		$keys = array_fill_keys( array_keys( self::MQ_WEIGHTS ), 0 );
		foreach ( $rows as $r ) {
			$sum += (float) $r['mq']['score'];
			foreach ( (array) $r['mq']['keys'] as $k ) {
				if ( isset( $keys[ $k ] ) ) {
					$keys[ $k ]++;
				}
			}
		}
		return array( 'score' => round( $sum / $n, 1 ), 'orders' => $n, 'coverage' => array_map( static function ( $c ) use ( $n ) { return (int) round( $c / $n * 100 ); }, $keys ) );
	}
}
