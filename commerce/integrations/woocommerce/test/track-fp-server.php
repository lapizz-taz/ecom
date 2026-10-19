<?php
/**
 * A stand-in store for the first-party tracking test (track-fp-e2e.cjs), served by PHP's own
 * web server — no WordPress, no network:
 *   FFC_STATE=/tmp/dir php -S 127.0.0.1:8095 integrations/woocommerce/test/track-fp-server.php
 * The real FFC_Tracking class answers the route; the WordPress functions it uses are stubbed
 * below, with options and the object cache kept in $FFC_STATE so they last between requests.
 * Calls to Meta and TikTok are written to $FFC_STATE/sent.json instead of leaving the machine.
 *
 * Pages: /product/ (ViewContent), /old-product/ (the same page cached before 1.6.0), /checkout/ (InitiateCheckout), /thanks/ (Purchase of order 42),
 * /ffc-s.js (the plugin's browser script), /__summary (first_party_summary), /__state (raw state).
 */

$STATE = getenv( 'FFC_STATE' ) ? getenv( 'FFC_STATE' ) : sys_get_temp_dir() . '/ffc-fp';
@mkdir( $STATE, 0777, true );
define( 'ABSPATH', __DIR__ . '/' );
define( 'FFC_VERSION', '1.6.0' );
define( 'FFC_URL', '/' );
define( 'MINUTE_IN_SECONDS', 60 );
define( 'HOUR_IN_SECONDS', 3600 );
define( 'DAY_IN_SECONDS', 86400 );

function ffc_state( $name, $default ) {
	global $STATE;
	$f = "$STATE/$name.json";
	return is_file( $f ) ? json_decode( file_get_contents( $f ), true ) : $default;
}
function ffc_state_put( $name, $value ) {
	global $STATE;
	file_put_contents( "$STATE/$name.json", json_encode( $value ), LOCK_EX );
}

// --- WordPress stand-ins --------------------------------------------------------------------
function get_option( $k, $d = false ) { $o = ffc_state( 'options', array() ); return array_key_exists( $k, $o ) ? $o[ $k ] : $d; }
function update_option( $k, $v, $a = null ) { $o = ffc_state( 'options', array() ); $o[ $k ] = $v; ffc_state_put( 'options', $o ); return true; }
function add_action() {}
function apply_filters( $tag, $v ) { return $v; }
function wp_json_encode( $d ) { return json_encode( $d ); }
function wp_unslash( $v ) { return $v; }
function sanitize_text_field( $v ) { return trim( strip_tags( (string) $v ) ); }
function esc_url_raw( $v ) { return filter_var( $v, FILTER_SANITIZE_URL ); }
function absint( $v ) { return abs( (int) $v ); }
function wp_parse_url( $u, $c = -1 ) { return parse_url( $u, $c ); }
function home_url( $path = '' ) { return 'http://' . $_SERVER['HTTP_HOST'] . $path; }
function add_query_arg( $k, $v, $url ) { return $url . ( strpos( $url, '?' ) === false ? '?' : '&' ) . rawurlencode( $k ) . '=' . rawurlencode( $v ); }
function is_ssl() { return false; }
function status_header( $c ) { http_response_code( $c ); }
function wp_rand( $a, $b ) { return random_int( $a, $b ); }
function wp_generate_password( $n ) { $c = 'abcdefghijklmnopqrstuvwxyz0123456789'; $o = ''; for ( $i = 0; $i < $n; $i++ ) { $o .= $c[ random_int( 0, 35 ) ]; } return $o; }
function is_email( $e ) { return (bool) filter_var( $e, FILTER_VALIDATE_EMAIL ); }
function wp_list_pluck( $l, $f ) { return array_map( function ( $r ) use ( $f ) { return $r[ $f ]; }, $l ); }
function get_current_user_id() { return 0; }
function is_wp_error( $x ) { return false; }
function wp_using_ext_object_cache() { return true; } // like a store with Redis: the server-side once-only guard is on
function wp_cache_add( $k, $v, $g, $ttl ) { $c = ffc_state( 'cache', array() ); if ( isset( $c[ "$g:$k" ] ) ) { return false; } $c[ "$g:$k" ] = $v; ffc_state_put( 'cache', $c ); return true; }
function wp_cache_incr( $k, $n, $g ) { $c = ffc_state( 'cache', array() ); $c[ "$g:$k" ] = ( isset( $c[ "$g:$k" ] ) ? (int) $c[ "$g:$k" ] : 0 ) + $n; ffc_state_put( 'cache', $c ); return $c[ "$g:$k" ]; }
function wp_remote_post( $url, $args ) {
	$sent   = ffc_state( 'sent', array() );
	$sent[] = array( 'url' => $url, 'headers' => isset( $args['headers'] ) ? $args['headers'] : array(), 'body' => json_decode( $args['body'], true ) );
	ffc_state_put( 'sent', $sent );
	return array( 'code' => 200, 'body' => json_encode( array( 'events_received' => 1, 'code' => 0 ) ) );
}
function wp_remote_retrieve_response_code( $r ) { return $r['code']; }
function wp_remote_retrieve_body( $r ) { return $r['body']; }
class FFC_Log { public static function warning( $m ) {} public static function info( $m ) {} }
class SimProduct {
	public $id;
	public function __construct( $id ) { $this->id = $id; }
	public function get_id() { return $this->id; }
	public function get_sku() { return 'SKU-' . $this->id; }
	public function get_name() { return 'Blue Kurti'; }
	public function get_price() { return 700; }
}
function wc_get_product( $id ) { return 7 === (int) $id ? new SimProduct( 7 ) : null; }
function get_woocommerce_currency() { return 'BDT'; }

require __DIR__ . '/../fullfilio-connect/includes/class-ffc-tracking.php';

if ( ! get_option( FFC_Tracking::OPTION ) ) {
	update_option( 'permalink_structure', getenv( 'FFC_PLAIN' ) ? '' : '/%postname%/' );
	FFC_Tracking::save( array(
		'meta_on' => '1', 'meta_pixel' => '111222333', 'meta_token' => 'META_TOKEN', 'meta_test' => '',
		'tiktok_on' => '', 'tiktok_pixel' => '', 'tiktok_token' => '', 'tiktok_test' => '',
		'google_on' => '', 'trigger' => 'placed', 'min_rr' => '40', 'dup_hours' => '24',
		'exclude_low_rr' => '1', 'skip_duplicates' => '1', 'browser_events' => '1', 'server_events' => '1', 'advanced_matching' => '1', 'browser_purchase' => '',
	) );
}

// --- the request ------------------------------------------------------------------------------
$path = parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH );
if ( 'POST' === $_SERVER['REQUEST_METHOD'] ) {
	FFC_Tracking::route(); // answers and exits when it is the route
	http_response_code( 404 );
	echo 'not the route';
	return true;
}
if ( '/ffc-s.js' === $path || '/ffc-track.js' === $path ) {
	header( 'Content-Type: application/javascript' );
	readfile( __DIR__ . '/../fullfilio-connect/assets' . $path );
	return true;
}
if ( '/__summary' === $path ) {
	header( 'Content-Type: application/json' );
	echo json_encode( FFC_Tracking::first_party_summary( 24 ) );
	return true;
}
if ( '/__state' === $path ) {
	header( 'Content-Type: application/json' );
	echo json_encode( array( 'sent' => ffc_state( 'sent', array() ), 'route' => get_option( FFC_Tracking::ROUTE_OPT ), 'endpoint' => FFC_Tracking::endpoint() ) );
	return true;
}
$product = array( 'id' => 'SKU-7', 'pid' => 7, 'name' => 'Blue Kurti', 'price' => 700, 'quantity' => 1, 'currency' => 'BDT' );
$cfg     = array(
	'meta' => '111222333', 'tiktok' => '', 'gads' => '', 'gadsLabel' => '', 'ga4' => '',
	'page' => 'other', 'product' => null, 'cart' => null, 'purchase' => null, 'funnel' => true,
	'server' => FFC_Tracking::endpoint(), 'currency' => 'BDT', 'am' => null,
);
if ( '/product/' === $path || '/old-product/' === $path ) {
	$cfg['page']    = 'product';
	$cfg['product'] = $product;
} elseif ( '/checkout/' === $path ) {
	$qty         = isset( $_GET['qty'] ) ? (int) $_GET['qty'] : 1;
	$cfg['page'] = 'checkout';
	$cfg['cart'] = array( 'value' => 700 * $qty, 'currency' => 'BDT', 'contents' => array( array( 'id' => 'SKU-7', 'name' => 'Blue Kurti', 'quantity' => $qty, 'item_price' => 700 ) ) );
} elseif ( '/thanks/' === $path ) {
	$cfg['purchase'] = array( 'event_id' => 'ffc_ord_42', 'txn' => '1042', 'value' => 1400, 'currency' => 'BDT', 'contents' => array( array( 'id' => 'SKU-7', 'name' => 'Blue Kurti', 'quantity' => 2, 'item_price' => 700 ) ) );
}
header( 'Content-Type: text/html; charset=utf-8' );
echo '<!doctype html><html><head><title>Demo store</title></head><body><h1>' . htmlspecialchars( $path ) . '</h1>';
if ( '/product/' === $path ) {
	echo '<form class="cart" method="post" action="/product/"><input name="quantity" value="2"><button name="add-to-cart" value="7">Add to cart</button></form>';
}
// /old-product/ is a page a cache saved before 1.6.0: it still asks for ffc-track.js.
echo '<script>var ffcTrack = ' . json_encode( $cfg ) . ';</script><script src="' . ( '/old-product/' === $path ? '/ffc-track.js' : '/ffc-s.js' ) . '"></script></body></html>';
return true;
