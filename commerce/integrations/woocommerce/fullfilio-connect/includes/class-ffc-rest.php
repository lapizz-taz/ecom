<?php
/**
 * Routes Fullfilio calls on this site, all under /wp-json/fullfilio/v1/:
 *
 *   POST pair    {endpoint, channel_id, secret, app_name, app_url, config}
 *   GET  status  health report (versions, queue, checks)
 *   POST unpair  forget the connection (store disconnected in Fullfilio)
 *
 * They are authenticated exactly like WooCommerce's own REST API: with the
 * Read/Write API keys the owner approved for Fullfilio (WooCommerce checks
 * them; we only accept users who can manage WooCommerce). Nothing here is
 * reachable without those keys.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Rest {
	const NS = 'fullfilio/v1';

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
		// Let WooCommerce authenticate its API keys on our routes too.
		add_filter( 'woocommerce_rest_is_request_to_rest_api', array( __CLASS__, 'is_our_route' ) );
	}

	public static function is_our_route( $is ) {
		if ( $is ) {
			return true;
		}
		$uri = isset( $_SERVER['REQUEST_URI'] ) ? esc_url_raw( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '';
		return false !== strpos( $uri, trailingslashit( rest_get_url_prefix() ) . self::NS . '/' )
			|| false !== strpos( $uri, 'rest_route=/' . self::NS . '/' )
			|| false !== strpos( $uri, 'rest_route=%2F' . str_replace( '/', '%2F', self::NS ) );
	}

	public static function routes() {
		$admin = array( __CLASS__, 'can_manage' );
		register_rest_route( self::NS, '/pair', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'pair' ), 'permission_callback' => $admin ) );
		register_rest_route( self::NS, '/status', array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'status' ), 'permission_callback' => $admin ) );
		register_rest_route( self::NS, '/unpair', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'unpair' ), 'permission_callback' => $admin ) );
	}

	public static function can_manage() {
		if ( current_user_can( 'manage_woocommerce' ) ) {
			return true;
		}
		return new WP_Error( 'ffc_forbidden', __( 'Use the WooCommerce API keys approved for Fullfilio.', 'fullfilio-connect' ), array( 'status' => rest_authorization_required_code() ) );
	}

	public static function pair( WP_REST_Request $request ) {
		$saved = FFC_Settings::save_connection( (array) $request->get_json_params() );
		if ( is_wp_error( $saved ) ) {
			$saved->add_data( array( 'status' => 422 ) );
			return $saved;
		}
		FFC_Log::info( 'Connected to Fullfilio', array( 'channel' => FFC_Settings::connection()['channel_id'] ) );
		FFC_Health::schedule();
		// Say hello in the background so Fullfilio shows the plugin as online straight away.
		FFC_Outbox::push( 'heartbeat', FFC_Health::report() );
		return rest_ensure_response( array( 'ok' => true, 'version' => FFC_VERSION, 'report' => FFC_Health::report() ) );
	}

	public static function status() {
		return rest_ensure_response( array( 'ok' => true, 'connected' => FFC_Settings::connected(), 'report' => FFC_Health::report( true ) ) );
	}

	public static function unpair() {
		FFC_Settings::forget_connection();
		FFC_Log::info( 'Disconnected from Fullfilio' );
		return rest_ensure_response( array( 'ok' => true ) );
	}
}
