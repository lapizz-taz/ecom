<?php
/**
 * The connection to Fullfilio and the feature switches it sends back.
 *
 * The connection (endpoint, channel id, signing secret) is written only by
 * Fullfilio itself, through /wp-json/fullfilio/v1/pair called with the
 * WooCommerce API keys the owner approved, or by an administrator pasting the
 * connection code. The secret is never shown again.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Settings {
	const CONNECTION = 'ffc_connection';
	const CONFIG     = 'ffc_config';
	const STATE      = 'ffc_state';

	/** Feature switches until Fullfilio sends its own (all safe to leave on). */
	public static function default_config() {
		return array(
			'capture_leads'    => true,
			'attribution'      => true,
			'order_events'     => true,
			'shield'           => false,
			'shield_fail_open' => true,
			'shield_timeout'   => 4,
			'custom_statuses'  => true,
			'stock_sync'       => false,
		);
	}

	/** @return array{endpoint:string,channel_id:string,secret:string,app_name:string,app_url:string,paired_at:string}|null */
	public static function connection() {
		$c = get_option( self::CONNECTION );
		if ( ! is_array( $c ) || empty( $c['endpoint'] ) || empty( $c['channel_id'] ) || empty( $c['secret'] ) ) {
			return null;
		}
		// Stores paired while the app ran on a temporary *.vercel.app address open the real one.
		$host = isset( $c['app_url'] ) ? wp_parse_url( $c['app_url'], PHP_URL_HOST ) : '';
		if ( is_string( $host ) && preg_match( '/\.vercel\.app$/i', $host ) ) {
			$c['app_url'] = 'https://fullfilio.com/admin';
		}
		return $c;
	}

	public static function connected() {
		return null !== self::connection();
	}

	/**
	 * Saves a connection after checking its parts. Returns WP_Error when invalid.
	 *
	 * @param array $input endpoint, channel_id, secret, app_name?, app_url?
	 * @return true|WP_Error
	 */
	public static function save_connection( $input ) {
		$endpoint   = isset( $input['endpoint'] ) ? esc_url_raw( trim( (string) $input['endpoint'] ) ) : '';
		$channel_id = isset( $input['channel_id'] ) ? strtolower( trim( (string) $input['channel_id'] ) ) : '';
		$secret     = isset( $input['secret'] ) ? trim( (string) $input['secret'] ) : '';
		if ( ! preg_match( '#^https?://#i', $endpoint ) ) {
			return new WP_Error( 'ffc_endpoint', __( 'The Fullfilio address is not valid.', 'fullfilio-connect' ) );
		}
		// HTTPS only. Plain HTTP needs define( 'FFC_ALLOW_HTTP', true ) in wp-config.php (local testing).
		if ( 0 !== stripos( $endpoint, 'https://' ) && ! ( defined( 'FFC_ALLOW_HTTP' ) && FFC_ALLOW_HTTP ) ) {
			return new WP_Error( 'ffc_https', __( 'Fullfilio must be reached over HTTPS.', 'fullfilio-connect' ) );
		}
		if ( ! preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $channel_id ) ) {
			return new WP_Error( 'ffc_channel', __( 'The store id is not valid.', 'fullfilio-connect' ) );
		}
		if ( strlen( $secret ) < 32 || strlen( $secret ) > 200 ) {
			return new WP_Error( 'ffc_secret', __( 'The connection secret is not valid.', 'fullfilio-connect' ) );
		}
		update_option(
			self::CONNECTION,
			array(
				'endpoint'   => untrailingslashit( $endpoint ),
				'channel_id' => $channel_id,
				'secret'     => $secret,
				'app_name'   => isset( $input['app_name'] ) ? sanitize_text_field( $input['app_name'] ) : 'Fullfilio',
				'app_url'    => isset( $input['app_url'] ) ? esc_url_raw( $input['app_url'] ) : '',
				'app_logo'   => isset( $input['app_logo'] ) && preg_match( '#^https://#i', (string) $input['app_logo'] ) ? esc_url_raw( $input['app_logo'] ) : '',
				'paired_at'  => gmdate( 'c' ),
			),
			false
		);
		if ( isset( $input['config'] ) && is_array( $input['config'] ) ) {
			self::save_config( $input['config'] );
		}
		return true;
	}

	public static function forget_connection() {
		delete_option( self::CONNECTION );
		delete_option( self::STATE );
	}

	public static function config() {
		$saved = get_option( self::CONFIG, array() );
		return array_merge( self::default_config(), is_array( $saved ) ? $saved : array() );
	}

	public static function enabled( $feature ) {
		$c = self::config();
		return self::connected() && ! empty( $c[ $feature ] );
	}

	/** Keeps only known switches with the right types. */
	public static function save_config( $input ) {
		$defaults = self::default_config();
		$out      = array();
		foreach ( $defaults as $key => $default ) {
			if ( ! array_key_exists( $key, $input ) ) {
				continue;
			}
			$out[ $key ] = is_bool( $default ) ? (bool) $input[ $key ] : max( 1, min( 10, (int) $input[ $key ] ) );
		}
		update_option( self::CONFIG, array_merge( self::config(), $out ), false );
	}

	public static function state() {
		$s = get_option( self::STATE, array() );
		return is_array( $s ) ? $s : array();
	}

	public static function set_state( $patch ) {
		update_option( self::STATE, array_merge( self::state(), $patch ), false );
	}

	/**
	 * Connection code shown in Fullfilio as a fallback when Fullfilio cannot reach
	 * this site: base64url of {"e":endpoint,"c":channel_id,"s":secret,"n":app_name}.
	 *
	 * @return array|WP_Error
	 */
	public static function parse_code( $code ) {
		$code = preg_replace( '/\s+/', '', (string) $code );
		$code = preg_replace( '/^ffc1\./', '', $code );
		$json = base64_decode( strtr( $code, '-_', '+/' ), true );
		$data = $json ? json_decode( $json, true ) : null;
		if ( ! is_array( $data ) || empty( $data['e'] ) || empty( $data['c'] ) || empty( $data['s'] ) ) {
			return new WP_Error( 'ffc_code', __( 'That connection code is not valid. Copy it again from Fullfilio.', 'fullfilio-connect' ) );
		}
		return array(
			'endpoint'   => $data['e'],
			'channel_id' => $data['c'],
			'secret'     => $data['s'],
			'app_name'   => isset( $data['n'] ) ? $data['n'] : 'Fullfilio',
		);
	}
}
