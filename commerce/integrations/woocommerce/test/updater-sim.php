<?php
/**
 * Offline check of FFC_Updater's version handling: which published versions it
 * accepts (two or three parts, any number of digits) and when one counts as
 * newer than the installed plugin. The manifest download is stubbed.
 * Run: php integrations/woocommerce/test/updater-sim.php
 */

define( 'ABSPATH', __DIR__ . '/' );
define( 'FFC_VERSION', '1.4.2' );
define( 'FFC_FILE', __DIR__ . '/fullfilio-connect.php' );
define( 'HOUR_IN_SECONDS', 3600 );

$GLOBALS['BODY'] = '';
function apply_filters( $hook, $value ) { return $value; }
function get_site_transient( $k ) { return false; }
function set_site_transient( $k, $v, $t ) { return true; }
function wp_remote_get( $url, $args ) { return array( 'body' => $GLOBALS['BODY'] ); }
function is_wp_error( $x ) { return false; }
function wp_remote_retrieve_response_code( $r ) { return 200; }
function wp_remote_retrieve_body( $r ) { return $r['body']; }
function wp_parse_url( $url, $part = -1 ) { return parse_url( $url, $part ); }
function esc_url_raw( $u ) { return $u; }
function sanitize_text_field( $t ) { return trim( $t ); }
function wp_kses_post( $t ) { return $t; }

require __DIR__ . '/../fullfilio-connect/includes/class-ffc-updater.php';

$ok  = 0;
$bad = 0;
function check( $label, $cond ) {
	global $ok, $bad;
	if ( $cond ) {
		$ok++;
		echo "  PASS  $label\n";
	} else {
		$bad++;
		echo "  FAIL  $label\n";
	}
}

/** What the updater makes of a published version (null = refused). */
function published( $version, $package = 'https://fullfilio.com/downloads/fullfilio-connect.zip' ) {
	$GLOBALS['BODY'] = json_encode( array( 'version' => $version, 'package' => $package, 'sha256' => str_repeat( 'a', 64 ) ) );
	return FFC_Updater::manifest( true );
}

echo "Installed: " . FFC_VERSION . "\n";
check( '1.5 → 1.5.0', '1.5.0' === FFC_Updater::normalize( '1.5' ) );
check( '1.4.10 stays 1.4.10', '1.4.10' === FFC_Updater::normalize( '1.4.10' ) );
check( '1.4.3 is newer than 1.4.2', FFC_Updater::newer( '1.4.3' ) );
check( '1.4.10 is newer than 1.4.2 (two-digit last number)', FFC_Updater::newer( '1.4.10' ) );
check( '1.5 is newer than 1.4.2 (two parts)', FFC_Updater::newer( '1.5' ) );
check( '2.0.0 is newer', FFC_Updater::newer( '2.0.0' ) );
check( '1.4.2 is not newer than itself', ! FFC_Updater::newer( '1.4.2' ) );
check( '1.4.1 is not newer', ! FFC_Updater::newer( '1.4.1' ) );
check( '1.4 is not newer (it is 1.4.0)', ! FFC_Updater::newer( '1.4' ) );

check( 'a published 1.4.3 is read', '1.4.3' === ( published( '1.4.3' )['version'] ?? null ) );
check( 'a published 1.5 is read', '1.5' === ( published( '1.5' )['version'] ?? null ) );
check( 'a published 1.4.10 is read', '1.4.10' === ( published( '1.4.10' )['version'] ?? null ) );
check( 'v1.5 is refused', null === published( 'v1.5' ) );
check( '1.4.2.1 is refused', null === published( '1.4.2.1' ) );
check( '1 is refused', null === published( '1' ) );
check( 'a package on another host is refused', null === published( '1.4.3', 'https://evil.example/fullfilio-connect.zip' ) );
check( 'a plain-http package is refused', null === published( '1.4.3', 'http://fullfilio.com/downloads/fullfilio-connect.zip' ) );

echo "\n$ok passed, $bad failed\n";
exit( $bad ? 1 : 0 );
