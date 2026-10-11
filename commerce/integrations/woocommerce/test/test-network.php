<?php
/**
 * Plugin Name: Test network shim (tests only)
 * Description: In the test setup Fullfilio's local address (127.0.0.1:54321) is the host, which
 *              this container reaches as 172.18.0.1. Rewrites those requests; nothing else.
 */
defined( 'ABSPATH' ) || exit;
add_filter(
	'pre_http_request',
	static function ( $pre, $args, $url ) {
		if ( 0 === strpos( $url, 'http://127.0.0.1:54321/' ) ) {
			return wp_remote_request( 'http://172.18.0.1:54321/' . substr( $url, strlen( 'http://127.0.0.1:54321/' ) ), $args );
		}
		return $pre;
	},
	10,
	3
);
