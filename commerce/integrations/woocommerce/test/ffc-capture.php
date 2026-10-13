<?php
/**
 * Plugin Name: Ad-platform capture (tests only)
 * Description: Records Meta / TikTok / Google server calls instead of sending them, and answers like each API does.
 */
defined( 'ABSPATH' ) || exit;
add_filter(
	'pre_http_request',
	static function ( $pre, $args, $url ) {
		if ( ! preg_match( '#^https://(graph\.facebook\.com|business-api\.tiktok\.com|www\.google-analytics\.com)/#', $url, $m ) ) {
			return $pre;
		}
		$log   = get_option( 'ffc_test_captured', array() );
		$log[] = array( 'url' => $url, 'headers' => isset( $args['headers'] ) ? $args['headers'] : array(), 'body' => isset( $args['body'] ) ? $args['body'] : '' );
		update_option( 'ffc_test_captured', $log, false );
		$google = 'www.google-analytics.com' === $m[1];
		$body   = 'business-api.tiktok.com' === $m[1] ? '{"code":0,"message":"OK"}' : ( $google ? '' : '{"events_received":1}' );
		return array( 'headers' => array(), 'body' => $body, 'response' => array( 'code' => $google ? 204 : 200, 'message' => 'OK' ), 'cookies' => array(), 'filename' => null );
	},
	5,
	3
);
