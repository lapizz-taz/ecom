<?php
/**
 * Offline simulation of FFC_Tracking: the send gate (call-confirmed only, skip
 * low receive rate, de-dup) and the Meta / TikTok / Google payloads. No network:
 * wp_remote_post is stubbed to capture what would be sent. Run: php test/track-sim.php
 */

define( 'ABSPATH', __DIR__ . '/' );
define( 'FFC_VERSION', '1.3.0' );
define( 'FFC_URL', 'https://shop.test/wp-content/plugins/fullfilio-connect/' );

$GLOBALS['SENT']    = array();
$GLOBALS['OPTIONS'] = array();

function wp_json_encode( $d ) { return json_encode( $d ); }
function add_action() {}
function wp_list_pluck( $list, $field ) { return array_map( function ( $r ) use ( $field ) { return is_array( $r ) ? $r[ $field ] : $r->$field; }, $list ); }
function get_option( $k, $d = false ) { return array_key_exists( $k, $GLOBALS['OPTIONS'] ) ? $GLOBALS['OPTIONS'][ $k ] : $d; }
function update_option( $k, $v, $a = true ) { $GLOBALS['OPTIONS'][ $k ] = $v; return true; }
function is_wp_error( $x ) { return $x instanceof WP_Error; }
function add_query_arg( $args, $url ) { return $url . ( strpos( $url, '?' ) === false ? '?' : '&' ) . http_build_query( $args ); }
function wp_remote_post( $url, $args ) {
	$GLOBALS['SENT'][] = array( 'url' => $url, 'headers' => isset( $args['headers'] ) ? $args['headers'] : array(), 'body' => json_decode( $args['body'], true ) );
	return array( 'code' => 200, 'body' => json_encode( array( 'events_received' => 1, 'code' => 0 ) ) );
}
function wp_remote_retrieve_response_code( $r ) { return $r['code']; }
function wp_remote_retrieve_body( $r ) { return $r['body']; }
class WP_Error {}
class FFC_Log { public static function warning( $m ) {} public static function info( $m ) {} }

class WC_Order_Item_Product {
	public $id; public $name; public $qty; public $total;
	public function __construct( $id, $name, $qty, $total ) { $this->id = $id; $this->name = $name; $this->qty = $qty; $this->total = $total; }
	public function get_product() { $p = new stdClass(); return null; }
	public function get_name() { return $this->name; }
	public function get_quantity() { return $this->qty; }
	public function get_product_id() { return $this->id; }
}

class WC_Order {}
function wc_get_order( $id ) { return isset( $GLOBALS['CUR_ORDER'] ) ? $GLOBALS['CUR_ORDER'] : null; }

class MockOrder extends WC_Order {
	public $meta = array(); public $status;
	public function __construct( $status ) { $this->status = $status; }
	public function get_id() { return 42; }
	public function get_order_number() { return '1042'; }
	public function get_total() { return 1500.0; }
	public function get_currency() { return 'BDT'; }
	public function get_item_count() { return 2; }
	public function get_items() { return array( new WC_Order_Item_Product( 7, 'Blue Kurti', 2, 1400.0 ) ); }
	public function get_item_total( $item, $a = false, $b = false ) { return 700.0; }
	public function get_billing_email() { return 'Shanta@Example.com'; }
	public function get_billing_phone() { return '01712-345678'; }
	public function get_billing_first_name() { return 'Shanta'; }
	public function get_billing_last_name() { return 'Akter'; }
	public function get_billing_city() { return 'Dhaka'; }
	public function get_billing_country() { return 'BD'; }
	public function get_customer_id() { return 9; }
	public function get_checkout_order_received_url() { return 'https://shop.test/checkout/order-received/42/'; }
	public function get_meta( $k ) { return isset( $this->meta[ $k ] ) ? $this->meta[ $k ] : ''; }
	public function update_meta_data( $k, $v ) { $this->meta[ $k ] = $v; }
	public function save_meta_data() {}
}

require __DIR__ . '/../fullfilio-connect/includes/class-ffc-tracking.php';

$ok = 0; $fail = 0;
function check( $label, $cond ) {
	global $ok, $fail;
	if ( $cond ) { $ok++; echo "  PASS  $label\n"; } else { $fail++; echo "  FAIL  $label\n"; }
}

$settings = FFC_Tracking::defaults();
$settings['meta']   = array( 'on' => true, 'pixel' => '111222333', 'token' => 'META_TOKEN', 'test' => '' );
$settings['tiktok'] = array( 'on' => true, 'pixel' => 'CABC123', 'token' => 'TT_TOKEN', 'test' => '' );
$settings['google'] = array( 'on' => true, 'conv_id' => 'AW-999', 'conv_label' => 'lbl', 'ga4_id' => 'G-XYZ', 'ga4_secret' => 'GA4_SECRET' );

// Attribution saved on the order (as FFC_Checkout would store it).
$attr = array(
	'fbp'        => 'fb.1.100.200',
	'fbc'        => null,
	'ttp'        => 'TTP_COOKIE',
	'ga_cid'     => '1111.2222',
	'ip'         => '103.10.10.10',
	'user_agent' => 'Mozilla/5.0',
	'last_touch' => array( 'params' => array( 'fbclid' => 'FBCLID123', 'ttclid' => 'TTCLID456', 'gclid' => 'GCLID789' ) ),
	'first_touch'=> array( 'params' => array() ),
);

echo "Scenario 1 — confirmed order, good receive rate → sends to all three\n";
$GLOBALS['SENT'] = array();
$o = new MockOrder( 'confirmed' );
$o->meta['_ffc_attribution'] = json_encode( $attr );
$o->meta[ FFC_Tracking::RR_META ] = 72;
FFC_Tracking::maybe_send( $o, $settings );
$urls = array_map( function ( $s ) { return $s['url']; }, $GLOBALS['SENT'] );
check( '3 events sent', count( $GLOBALS['SENT'] ) === 3 );
check( 'Meta endpoint hit', (bool) preg_grep( '#graph.facebook.com/.*/111222333/events#', $urls ) );
check( 'TikTok endpoint hit', (bool) preg_grep( '#business-api.tiktok.com#', $urls ) );
check( 'GA4 endpoint hit', (bool) preg_grep( '#google-analytics.com/mp/collect#', $urls ) );
// Meta payload shape
$meta = null; foreach ( $GLOBALS['SENT'] as $s ) { if ( strpos( $s['url'], 'facebook' ) !== false ) { $meta = $s; } }
$ev = $meta['body']['data'][0];
check( 'Meta event is Purchase', $ev['event_name'] === 'Purchase' );
check( 'Meta value+currency', $ev['custom_data']['value'] === 1500 && $ev['custom_data']['currency'] === 'BDT' );
check( 'Meta email hashed (sha256 of lowercased)', $ev['user_data']['em'][0] === hash( 'sha256', 'shanta@example.com' ) );
check( 'Meta phone hashed as 880…', $ev['user_data']['ph'][0] === hash( 'sha256', '8801712345678' ) );
check( 'Meta fbp carried', $ev['user_data']['fbp'] === 'fb.1.100.200' );
check( 'Meta fbc reconstructed from fbclid', isset( $ev['user_data']['fbc'] ) && strpos( $ev['user_data']['fbc'], 'FBCLID123' ) !== false );
check( 'Meta event_id stable', $ev['event_id'] === 'ffc_ord_42' );
check( 'Meta token in body, not user data', $meta['body']['access_token'] === 'META_TOKEN' );
// TikTok
$tt = null; foreach ( $GLOBALS['SENT'] as $s ) { if ( strpos( $s['url'], 'tiktok' ) !== false ) { $tt = $s; } }
check( 'TikTok event CompletePayment', $tt['body']['data'][0]['event'] === 'CompletePayment' );
check( 'TikTok ttclid carried', $tt['body']['data'][0]['user']['ttclid'] === 'TTCLID456' );
check( 'TikTok token in header', isset( $tt['headers']['Access-Token'] ) && $tt['headers']['Access-Token'] === 'TT_TOKEN' );
check( 'TikTok same event_id', $tt['body']['data'][0]['event_id'] === 'ffc_ord_42' );
check( 'TikTok _ttp cookie carried', $tt['body']['data'][0]['user']['ttp'] === 'TTP_COOKIE' );
check( 'TikTok external_id hashed customer id', $tt['body']['data'][0]['user']['external_id'] === hash( 'sha256', '9' ) );
// Google
$g = null; foreach ( $GLOBALS['SENT'] as $s ) { if ( strpos( $s['url'], 'google-analytics' ) !== false ) { $g = $s; } }
check( 'GA4 purchase event', $g['body']['events'][0]['name'] === 'purchase' );
check( 'GA4 gclid param', $g['body']['events'][0]['params']['gclid'] === 'GCLID789' );
check( 'GA4 enhanced-conv email', $g['body']['user_data']['sha256_email_address'] === hash( 'sha256', 'shanta@example.com' ) );
check( 'GA4 phone hashed in E.164 (+880…)', $g['body']['user_data']['sha256_phone_number'] === hash( 'sha256', '+8801712345678' ) );
check( 'GA4 client_id from the _ga cookie', $g['body']['client_id'] === '1111.2222' );
check( 'GA4 secret in URL only', strpos( $g['url'], 'GA4_SECRET' ) !== false );
check( 'order marked sent', (bool) $o->get_meta( FFC_Tracking::SENT ) );

echo "\nScenario 2 — low receive rate (30 < 40) → nothing sent\n";
$GLOBALS['SENT'] = array();
$o2 = new MockOrder( 'confirmed' );
$o2->meta['_ffc_attribution'] = json_encode( $attr );
$o2->meta[ FFC_Tracking::RR_META ] = 30;
FFC_Tracking::maybe_send( $o2, $settings );
check( 'held — 0 events', count( $GLOBALS['SENT'] ) === 0 );
check( 'not marked sent', ! $o2->get_meta( FFC_Tracking::SENT ) );

echo "\nScenario 3 — shield said 'advance' (low rate signal) → nothing sent\n";
$GLOBALS['SENT'] = array();
$o3 = new MockOrder( 'confirmed' );
$o3->meta['_ffc_shield'] = 'advance';
FFC_Tracking::maybe_send( $o3, $settings );
check( 'held — 0 events', count( $GLOBALS['SENT'] ) === 0 );

echo "\nScenario 4 — already sent → no double send\n";
$GLOBALS['SENT'] = array();
$o4 = new MockOrder( 'confirmed' );
$o4->meta[ FFC_Tracking::SENT ] = 'already';
$o4->meta[ FFC_Tracking::RR_META ] = 90;
FFC_Tracking::maybe_send( $o4, $settings );
check( 'deduped — 0 events', count( $GLOBALS['SENT'] ) === 0 );

echo "\nScenario 5 — trigger gate: status 'processing' is not a trigger for confirmed mode\n";
$GLOBALS['SENT'] = array();
FFC_Tracking::save( array_merge( flatten_settings( $settings ), array() ) ); // persist so on_status reads it
$o5 = new MockOrder( 'processing' );
$o5->meta[ FFC_Tracking::RR_META ] = 90;
FFC_Tracking::on_status( 42, 'pending', 'processing', $o5 );
check( 'not a trigger status — 0 events', count( $GLOBALS['SENT'] ) === 0 );

echo "\nScenario 6 — delivered-only mode: sends on 'delivered', not on 'confirmed'\n";
$deliv = $settings; $deliv['trigger'] = 'delivered';
$GLOBALS['SENT'] = array();
FFC_Tracking::save( flatten_settings( $deliv ) );
$o6 = new MockOrder( 'confirmed' ); $o6->meta[ FFC_Tracking::RR_META ] = 90; $o6->meta['_ffc_attribution'] = json_encode( $attr );
FFC_Tracking::on_status( 42, 'processing', 'confirmed', $o6 );
check( 'confirmed does NOT fire in delivered mode', count( $GLOBALS['SENT'] ) === 0 );
$o6b = new MockOrder( 'delivered' ); $o6b->meta[ FFC_Tracking::RR_META ] = 90; $o6b->meta['_ffc_attribution'] = json_encode( $attr );
FFC_Tracking::on_status( 42, 'shipped', 'delivered', $o6b );
check( 'delivered fires', count( $GLOBALS['SENT'] ) === 3 );

echo "\n$ok passed, $fail failed\n";

// Build the flat form-style array FFC_Tracking::save expects.
function flatten_settings( $s ) {
	return array(
		'meta_on' => $s['meta']['on'] ? '1' : '', 'meta_pixel' => $s['meta']['pixel'], 'meta_token' => $s['meta']['token'], 'meta_test' => $s['meta']['test'],
		'tiktok_on' => $s['tiktok']['on'] ? '1' : '', 'tiktok_pixel' => $s['tiktok']['pixel'], 'tiktok_token' => $s['tiktok']['token'], 'tiktok_test' => $s['tiktok']['test'],
		'google_on' => $s['google']['on'] ? '1' : '', 'google_conv_id' => $s['google']['conv_id'], 'google_conv_label' => $s['google']['conv_label'], 'google_ga4_id' => $s['google']['ga4_id'], 'google_ga4_secret' => $s['google']['ga4_secret'],
		'trigger' => $s['trigger'], 'exclude_low_rr' => $s['exclude_low_rr'] ? '1' : '', 'min_rr' => (string) $s['min_rr'], 'browser_events' => $s['browser_events'] ? '1' : '', 'browser_purchase' => $s['browser_purchase'] ? '1' : '',
	);
}

exit( $fail === 0 ? 0 : 1 );
