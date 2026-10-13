<?php
/**
 * Plugin Name: Ad-platform capture (tests only)
 * Description: Records Meta / TikTok / Google calls instead of sending them, and answers like each API does
 *              (Graph pixel read for the connection test, GA4's validation server, TikTok's code 0).
 */
defined( 'ABSPATH' ) || exit;
add_filter(
	'pre_http_request',
	static function ( $pre, $args, $url ) {
		if ( ! preg_match( '#^https://(graph\.facebook\.com|business-api\.tiktok\.com|www\.google-analytics\.com)/#', $url, $m ) ) {
			return $pre;
		}
		$method = isset( $args['method'] ) ? strtoupper( $args['method'] ) : 'GET';
		$log    = get_option( 'ffc_test_captured', array() );
		$log[]  = array( 'url' => $url, 'method' => $method, 'headers' => isset( $args['headers'] ) ? $args['headers'] : array(), 'body' => isset( $args['body'] ) ? $args['body'] : '' );
		update_option( 'ffc_test_captured', $log, false );
		$code = 200;
		$body = '{"events_received":1}';
		if ( 'graph.facebook.com' === $m[1] && 'GET' === $method ) {
			// Reading the pixel: answers like Graph when the token may use it.
			$ok   = isset( $args['headers']['Authorization'] ) && 'Bearer META_TEST_TOKEN' === $args['headers']['Authorization'];
			$id   = preg_match( '#/v\d+\.0/([^/?]+)#', $url, $p ) ? $p[1] : '';
			$code = $ok ? 200 : 400;
			$body = $ok ? wp_json_encode( array( 'id' => $id, 'name' => 'Demo Store pixel' ) ) : '{"error":{"message":"Invalid OAuth access token - Cannot parse access token","code":190}}';
		} elseif ( 'business-api.tiktok.com' === $m[1] ) {
			$body = '{"code":0,"message":"OK"}';
		} elseif ( false !== strpos( $url, '/debug/mp/collect' ) ) {
			$body = '{"validationMessages":[]}';
		} elseif ( 'www.google-analytics.com' === $m[1] ) {
			$code = 204;
			$body = '';
		}
		return array( 'headers' => array(), 'body' => $body, 'response' => array( 'code' => $code, 'message' => 'OK' ), 'cookies' => array(), 'filename' => null );
	},
	5,
	3
);
