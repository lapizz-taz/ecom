<?php
/**
 * Plugin Name: Update server shim (tests only)
 * Description: Points the Fullfilio Connect update check at the test's local manifest server.
 */
defined( 'ABSPATH' ) || exit;
add_filter( 'ffc_update_manifest_url', static function () { return 'http://172.18.0.1:8080/fullfilio-connect.json'; } );
// WordPress refuses downloads from private addresses; the test server is one.
add_filter( 'http_request_host_is_external', static function ( $external, $host ) { return '172.18.0.1' === $host ? true : $external; }, 10, 2 );
