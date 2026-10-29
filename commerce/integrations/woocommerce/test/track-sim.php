<?php
/**
 * Offline simulation of FFC_Tracking: when a Purchase counts (placed / confirmed /
 * delivered), the skips (low receive rate, shield, duplicate customer, already
 * sent), the Meta / TikTok / Google payloads and the match-quality estimate.
 * No network: wp_remote_post is stubbed to capture what would be sent.
 * Run: php integrations/woocommerce/test/track-sim.php
 */

define( 'ABSPATH', __DIR__ . '/' );
define( 'FFC_VERSION', '1.4.0' );
define( 'FFC_URL', 'https://shop.test/wp-content/plugins/fullfilio-connect/' );
define( 'HOUR_IN_SECONDS', 3600 );
define( 'DAY_IN_SECONDS', 86400 );
define( 'MINUTE_IN_SECONDS', 60 );

$GLOBALS['SENT']    = array();
$GLOBALS['OPTIONS'] = array();

function wp_json_encode( $d ) { return json_encode( $d ); }
function add_action() {}
function is_email( $e ) { return (bool) filter_var( $e, FILTER_VALIDATE_EMAIL ); }
function wp_list_pluck( $list, $field ) { return array_map( function ( $r ) use ( $field ) { return is_array( $r ) ? $r[ $field ] : $r->$field; }, $list ); }
function get_option( $k, $d = false ) { return array_key_exists( $k, $GLOBALS['OPTIONS'] ) ? $GLOBALS['OPTIONS'][ $k ] : $d; }
function update_option( $k, $v, $a = true ) { $GLOBALS['OPTIONS'][ $k ] = $v; return true; }
function is_wp_error( $x ) { return $x instanceof WP_Error; }
function add_query_arg( $args, $url ) { return $url . ( strpos( $url, '?' ) === false ? '?' : '&' ) . http_build_query( $args ); }
function wp_parse_url( $u, $c = -1 ) { return parse_url( $u, $c ); }
function wp_rand( $a, $b ) { return random_int( $a, $b ); }
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
	public function get_product() { return null; }
	public function get_name() { return $this->name; }
	public function get_quantity() { return $this->qty; }
	public function get_product_id() { return $this->id; }
}

class WC_Order {}
function wc_get_order( $id ) { return isset( $GLOBALS['CUR_ORDER'] ) ? $GLOBALS['CUR_ORDER'] : null; }
class SimDate { public function getTimestamp() { return time() - 3600; } }

class MockOrder extends WC_Order {
	public $meta = array(); public $status; public $id; public $phone; public $email;
	public function __construct( $status, $id = 42, $phone = '01712-345678', $email = 'Shanta@Example.com' ) { $this->status = $status; $this->id = $id; $this->phone = $phone; $this->email = $email; }
	public function get_id() { return $this->id; }
	public function get_order_number() { return (string) ( 1000 + $this->id ); }
	public function get_total() { return 1500.0; }
	public function get_currency() { return 'BDT'; }
	public function get_item_count() { return 2; }
	public function get_items() { return array( new WC_Order_Item_Product( 7, 'Blue Kurti', 2, 1400.0 ) ); }
	public function get_item_total( $item, $a = false, $b = false ) { return 700.0; }
	public function get_billing_email() { return $this->email; }
	public function get_billing_phone() { return $this->phone; }
	public function get_shipping_phone() { return ''; }
	public function get_billing_first_name() { return 'Shanta'; }
	public function get_billing_last_name() { return 'Akter'; }
	public function get_billing_city() { return 'Dhaka'; }
	public function get_billing_state() { return 'Dhaka'; }
	public function get_billing_postcode() { return '1205'; }
	public function get_billing_country() { return 'BD'; }
	public function get_customer_id() { return 9; }
	public function get_date_created() { return new SimDate(); }
	public function get_checkout_order_received_url() { return 'https://shop.test/checkout/order-received/' . $this->id . '/'; }
	public function get_meta( $k ) { return isset( $this->meta[ $k ] ) ? $this->meta[ $k ] : ''; }
	public function update_meta_data( $k, $v ) { $this->meta[ $k ] = $v; }
	public function save_meta_data() {}
}

require __DIR__ . '/../fullfilio-connect/includes/class-ffc-protect.php';
require __DIR__ . '/../fullfilio-connect/includes/class-ffc-tracking.php';

$ok = 0; $fail = 0;
function check( $label, $cond ) {
	global $ok, $fail;
	if ( $cond ) { $ok++; echo "  PASS  $label\n"; } else { $fail++; echo "  FAIL  $label\n"; }
}
function sent_to( $host ) { foreach ( $GLOBALS['SENT'] as $s ) { if ( strpos( $s['url'], $host ) !== false ) { return $s; } } return null; }
function reset_all() { $GLOBALS['SENT'] = array(); unset( $GLOBALS['OPTIONS'][ FFC_Tracking::SEEN_OPT ], $GLOBALS['OPTIONS'][ FFC_Tracking::LOG_OPT ] ); }
function attr_json() {
	return json_encode( array(
		'fbp' => 'fb.1.100.200', 'fbc' => null, 'ttp' => 'TTP_COOKIE', 'ga_cid' => '1111.2222', 'vid' => 'abc123visitor456xyz9',
		'ip' => '103.10.10.10', 'user_agent' => 'Mozilla/5.0',
		'last_touch' => array( 'at' => gmdate( 'c', time() - 7200 ), 'params' => array( 'fbclid' => 'FBCLID123', 'ttclid' => 'TTCLID456', 'gclid' => 'GCLID789' ) ),
		'first_touch' => array( 'params' => array() ),
	) );
}

$settings = FFC_Tracking::defaults();
$settings['meta']   = array( 'on' => true, 'pixel' => '111222333', 'token' => 'META_TOKEN', 'test' => '' );
$settings['tiktok'] = array( 'on' => true, 'pixel' => 'CABC123', 'token' => 'TT_TOKEN', 'test' => '' );
$settings['google'] = array( 'on' => true, 'conv_id' => 'AW-999', 'conv_label' => 'lbl', 'ga4_id' => 'G-XYZ', 'ga4_secret' => 'GA4_SECRET' );
$vid_h = hash( 'sha256', 'abc123visitor456xyz9' );

echo "Scenario 1 — confirmed order, good receive rate → sent to all three, every match key\n";
reset_all();
$o = new MockOrder( 'confirmed' );
$o->meta['_ffc_attribution'] = attr_json();
$o->meta[ FFC_Tracking::RR_META ] = 72;
FFC_Tracking::maybe_send( $o, $settings );
check( '3 events sent', count( $GLOBALS['SENT'] ) === 3 );
$meta = sent_to( 'graph.facebook.com' ); $ev = $meta['body']['data'][0]; $u = $ev['user_data'];
check( 'Meta Purchase to the pixel, stable event id', strpos( $meta['url'], '/111222333/events' ) !== false && 'Purchase' === $ev['event_name'] && 'ffc_ord_42' === $ev['event_id'] );
check( 'Meta value + currency', 1500 == $ev['custom_data']['value'] && 'BDT' === $ev['custom_data']['currency'] );
check( 'Meta email hashed (lower case)', $u['em'][0] === hash( 'sha256', 'shanta@example.com' ) );
check( 'Meta phone hashed as 8801…', $u['ph'][0] === hash( 'sha256', '8801712345678' ) );
check( 'Meta district, postcode, country hashed', $u['st'][0] === hash( 'sha256', 'dhaka' ) && $u['zp'][0] === hash( 'sha256', '1205' ) && $u['country'][0] === hash( 'sha256', 'bd' ) );
check( 'Meta external_id = hashed visitor id (+ customer id)', $u['external_id'][0] === $vid_h && $u['external_id'][1] === hash( 'sha256', 'wc_9' ) );
check( 'Meta fbc rebuilt from fbclid with the landing time', isset( $u['fbc'] ) && preg_match( '/^fb\.1\.\d{13}\.FBCLID123$/', $u['fbc'] ) && (int) explode( '.', $u['fbc'] )[2] < time() * 1000 - 3600000 );
check( 'Meta fbp, IP and browser', 'fb.1.100.200' === $u['fbp'] && '103.10.10.10' === $u['client_ip_address'] && 'Mozilla/5.0' === $u['client_user_agent'] );
check( 'Meta event time = when the order was placed (within 7 days)', $ev['event_time'] <= time() - 3500 && $ev['event_time'] >= time() - 3700 );
check( 'Meta token only in the body', 'META_TOKEN' === $meta['body']['access_token'] && strpos( $meta['url'], 'META_TOKEN' ) === false );
$tt = sent_to( 'tiktok' ); $te = $tt['body']['data'][0];
check( 'TikTok CompletePayment, token in header, same event id', 'CompletePayment' === $te['event'] && 'TT_TOKEN' === $tt['headers']['Access-Token'] && 'ffc_ord_42' === $te['event_id'] );
check( 'TikTok ttclid + _ttp + E.164 phone + visitor id', 'TTCLID456' === $te['user']['ttclid'] && 'TTP_COOKIE' === $te['user']['ttp'] && $te['user']['phone'] === hash( 'sha256', '+8801712345678' ) && $te['user']['external_id'] === $vid_h );
$g = sent_to( 'google-analytics' ); $gb = $g['body'];
check( 'GA4 purchase with gclid and the browser client id', 'purchase' === $gb['events'][0]['name'] && 'GCLID789' === $gb['events'][0]['params']['gclid'] && '1111.2222' === $gb['client_id'] );
check( 'GA4 enhanced conversions: email, E.164 phone, address', $gb['user_data']['sha256_email_address'][0] === hash( 'sha256', 'shanta@example.com' ) && $gb['user_data']['sha256_phone_number'][0] === hash( 'sha256', '+8801712345678' ) && 'BD' === $gb['user_data']['address'][0]['country'] && 'dhaka' === $gb['user_data']['address'][0]['city'] );
check( 'GA4 secret only in the URL', strpos( $g['url'], 'api_secret=GA4_SECRET' ) !== false );
$log = FFC_Tracking::recent( 1 );
check( 'match quality estimate 10/10 with every key', 10.0 === $log[0]['mq']['score'] );
check( 'order marked sent', (bool) $o->get_meta( FFC_Tracking::SENT ) && 'send' === $o->get_meta( '_ffc_track_decision' ) );

echo "\nScenario 2 — low receive rate (30 < 40) → not counted, reason kept\n";
reset_all();
$o2 = new MockOrder( 'confirmed', 43, '01811-000111' ); $o2->meta['_ffc_attribution'] = attr_json(); $o2->meta[ FFC_Tracking::RR_META ] = 30;
FFC_Tracking::maybe_send( $o2, $settings );
check( 'held — 0 events', 0 === count( $GLOBALS['SENT'] ) );
check( 'reason on the order and in the log', strpos( $o2->get_meta( FFC_Tracking::SKIP ), 'Low receive rate: 30%' ) === 0 && strpos( FFC_Tracking::recent( 1 )[0]['skipped'], 'Low receive rate' ) === 0 );

echo "\nScenario 3 — shield said 'advance' → not counted\n";
reset_all();
$o3 = new MockOrder( 'confirmed', 44, '01911-222333' ); $o3->meta['_ffc_shield'] = 'advance';
FFC_Tracking::maybe_send( $o3, $settings );
check( 'held — 0 events', 0 === count( $GLOBALS['SENT'] ) );

echo "\nScenario 4 — already sent → no double count\n";
reset_all();
$o4 = new MockOrder( 'confirmed' ); $o4->meta[ FFC_Tracking::SENT ] = 'already'; $o4->meta[ FFC_Tracking::RR_META ] = 90;
FFC_Tracking::maybe_send( $o4, $settings );
check( '0 events', 0 === count( $GLOBALS['SENT'] ) );

echo "\nScenario 5 — confirmed mode: 'processing' does not count\n";
reset_all();
FFC_Tracking::save( flatten_settings( $settings ) );
$o5 = new MockOrder( 'processing', 45 ); $o5->meta[ FFC_Tracking::RR_META ] = 90;
FFC_Tracking::on_status( 45, 'pending', 'processing', $o5 );
FFC_Tracking::on_placed( $o5 );
check( 'not a trigger — 0 events', 0 === count( $GLOBALS['SENT'] ) );

echo "\nScenario 6 — delivered mode: counts on 'delivered', not on 'confirmed'\n";
reset_all();
$deliv = $settings; $deliv['trigger'] = 'delivered';
FFC_Tracking::save( flatten_settings( $deliv ) );
$o6 = new MockOrder( 'confirmed', 46 ); $o6->meta[ FFC_Tracking::RR_META ] = 90; $o6->meta['_ffc_attribution'] = attr_json();
FFC_Tracking::on_status( 46, 'processing', 'confirmed', $o6 );
check( 'confirmed does not count in delivered mode', 0 === count( $GLOBALS['SENT'] ) );
FFC_Tracking::on_status( 46, 'shipped', 'delivered', $o6 );
check( 'delivered counts', 3 === count( $GLOBALS['SENT'] ) );

echo "\nScenario 7 — 'When the order is placed' (normal): counts at once, never twice\n";
reset_all();
$placed = $settings; $placed['trigger'] = 'placed';
FFC_Tracking::save( flatten_settings( $placed ) );
$o7 = new MockOrder( 'pending', 47, '01555-101010', 'buyer7@example.com' ); $o7->meta['_ffc_attribution'] = attr_json();
FFC_Tracking::on_placed( $o7 );
check( 'sent when placed', 3 === count( $GLOBALS['SENT'] ) && 'send' === $o7->get_meta( '_ffc_track_decision' ) );
FFC_Tracking::on_status( 47, 'processing', 'confirmed', $o7 );
FFC_Tracking::on_placed( $o7 );
check( 'later confirm / repeat does not send again', 3 === count( $GLOBALS['SENT'] ) );

echo "\nScenario 8 — duplicate orders: the same customer again within 24h counts once\n";
reset_all();
FFC_Tracking::save( flatten_settings( $settings ) );
$a = new MockOrder( 'confirmed', 50, '01712-999888', 'dup@example.com' ); $a->meta['_ffc_attribution'] = attr_json();
FFC_Tracking::maybe_send( $a, FFC_Tracking::settings() );
$b = new MockOrder( 'confirmed', 51, '+8801712999888', 'other@example.com' ); $b->meta['_ffc_attribution'] = attr_json();
FFC_Tracking::maybe_send( $b, FFC_Tracking::settings() );
check( 'first order sent, second (same phone, other format) not', 3 === count( $GLOBALS['SENT'] ) && strpos( $b->get_meta( FFC_Tracking::SKIP ), 'Duplicate' ) === 0 );
$c = new MockOrder( 'confirmed', 52, '01712-111222', 'dup@example.com' ); $c->meta['_ffc_attribution'] = attr_json();
FFC_Tracking::maybe_send( $c, FFC_Tracking::settings() );
check( 'another customer is sent', 6 === count( $GLOBALS['SENT'] ) );
$GLOBALS['OPTIONS'][ FFC_Tracking::SEEN_OPT ][ array_keys( $GLOBALS['OPTIONS'][ FFC_Tracking::SEEN_OPT ] )[0] ][0] = time() - 25 * 3600;
$d = new MockOrder( 'confirmed', 53, '01712-999888', 'dup@example.com' ); $d->meta['_ffc_attribution'] = attr_json();
FFC_Tracking::maybe_send( $d, FFC_Tracking::settings() );
check( 'the same customer after 24h is sent again', 9 === count( $GLOBALS['SENT'] ) );
$nodup = $settings; $nodup['skip_duplicates'] = false;
$e = new MockOrder( 'confirmed', 54, '01712-999888', 'dup@example.com' ); $e->meta['_ffc_attribution'] = attr_json();
FFC_Tracking::maybe_send( $e, $nodup );
check( 'with the duplicate rule off it is sent', 12 === count( $GLOBALS['SENT'] ) );

echo "\nScenario 9 — no email (typical COD order): match quality estimate drops to 8\n";
reset_all();
$f = new MockOrder( 'confirmed', 60, '01611-454545', '' ); $f->meta['_ffc_attribution'] = attr_json();
FFC_Tracking::maybe_send( $f, $settings );
$mq = FFC_Tracking::recent( 1 )[0]['mq'];
check( 'score 8.0 and no em key', 8.0 === $mq['score'] && ! in_array( 'em', $mq['keys'], true ) );
check( 'match summary averages the purchases', null !== FFC_Tracking::match_summary() && 0 === FFC_Tracking::match_summary()['coverage']['em'] );

echo "\nScenario 10 — phone formats normalise to the same 8801… digits\n";
check( '01712-345678 / +880 1712 345678 / 1712345678 / 008801712345678', count( array_unique( array_map( array( 'FFC_Tracking', 'phone_digits' ), array( '01712-345678', '+880 1712 345678', '1712345678', '008801712345678' ) ) ) ) === 1 );
check( '+880 01712345678 / +88 1712345678 / Bangla digits give 8801712345678', array( '8801712345678' ) === array_values( array_unique( array_map( array( 'FFC_Tracking', 'phone_digits' ), array( '+880 01712345678', '+88 1712345678', '০১৭১২৩৪৫৬৭৮' ) ) ) ) );

echo "\nScenario 11 — first-party route: only POSTs to this site's own path\n";
check( 'POST /k7f3q2m9/ and /k7f3q2m9 match', FFC_Tracking::route_matches( 'POST', '/k7f3q2m9/', array(), 'k7f3q2m9', '' ) && FFC_Tracking::route_matches( 'post', '/k7f3q2m9?x=1', array(), 'k7f3q2m9', '' ) );
check( 'GET, other paths and a deeper path do not', ! FFC_Tracking::route_matches( 'GET', '/k7f3q2m9/', array(), 'k7f3q2m9', '' ) && ! FFC_Tracking::route_matches( 'POST', '/shop/', array(), 'k7f3q2m9', '' ) && ! FFC_Tracking::route_matches( 'POST', '/k7f3q2m9/more/', array(), 'k7f3q2m9', '' ) );
check( 'WordPress in /store: /store/k7f3q2m9/ matches, /k7f3q2m9/ does not', FFC_Tracking::route_matches( 'POST', '/store/k7f3q2m9/', array(), 'k7f3q2m9', '/store' ) && ! FFC_Tracking::route_matches( 'POST', '/k7f3q2m9/', array(), 'k7f3q2m9', '/store' ) );
check( 'plain permalinks: /?k7f3q2m9=1 matches', FFC_Tracking::route_matches( 'POST', '/?k7f3q2m9=1', array( 'k7f3q2m9' => '1' ), 'k7f3q2m9', '' ) );
check( 'no route before one exists', ! FFC_Tracking::route_matches( 'POST', '/', array(), '', '' ) );

echo "\nScenario 12 — the visitor's ids renewed by the store's server\n";
$cfg  = FFC_Tracking::defaults();
$cfg['meta'] = array( 'on' => true, 'pixel' => '111', 'token' => 'T', 'test' => '' );
$cfg['tiktok'] = array( 'on' => true, 'pixel' => 'C1', 'token' => 'T', 'test' => '' );
$plan = function ( $cookies, $url, $cd = 'example.com.bd' ) use ( $cfg ) {
	$out = array();
	foreach ( FFC_Tracking::cookie_plan( $cookies, $url, 'www.example.com.bd', $cd, $cfg, 1760000000 ) as $c ) { $out[ $c['name'] ] = $c; }
	return $out;
};
$p = $plan( array( '_fbp' => 'fb.1.1700000000000.123456789', 'ffc_vid' => 'abcdefghijkl1234', '_ttp' => 'TTP_abc123xyz' ), 'https://www.example.com.bd/p/' );
check( 'existing _fbp, visitor id and _ttp renewed as they are', 'fb.1.1700000000000.123456789' === $p['_fbp']['value'] && 180 === $p['_fbp']['days'] && 'abcdefghijkl1234' === $p['ffc_vid']['value'] && 395 === $p['ffc_vid']['days'] && 'TTP_abc123xyz' === $p['_ttp']['value'] );
check( 'on the domain the pixel uses (example.com.bd)', 'example.com.bd' === $p['_fbp']['domain'] );
check( 'no fbclid and no _fbc: no _fbc', ! isset( $p['_fbc'] ) );
$p = $plan( array(), 'https://www.example.com.bd/?fbclid=IwAR_new-click01' );
check( 'missing _fbp made in Meta\'s format', (bool) preg_match( '/^fb\.1\.1760000000000\.\d{10}$/', $p['_fbp']['value'] ) );
check( 'fbclid in the address: _fbc = fb.1.<ms>.<fbclid>', 'fb.1.1760000000000.IwAR_new-click01' === $p['_fbc']['value'] && 90 === $p['_fbc']['days'] );
$p = $plan( array( '_fbc' => 'fb.1.1700000000000.IwAR_new-click01' ), 'https://www.example.com.bd/?fbclid=IwAR_new-click01' );
check( 'the same click again keeps its first time', 'fb.1.1700000000000.IwAR_new-click01' === $p['_fbc']['value'] );
$p = $plan( array( '_fbc' => 'fb.1.1700000000000.IwAR_old-click01' ), 'https://www.example.com.bd/?fbclid=IwAR_new-click02' );
check( 'a new click replaces the old one', 'fb.1.1760000000000.IwAR_new-click02' === $p['_fbc']['value'] );
$p = $plan( array( '_fbp' => 'fb.1.1;Domain=evil', 'ffc_vid' => '<script>', '_fbc' => 'x' ), 'https://www.example.com.bd/' );
check( 'tampered cookies are not echoed back', 0 === strpos( $p['_fbp']['value'], 'fb.1.1760000000000.' ) && ! isset( $p['ffc_vid'] ) && ! isset( $p['_fbc'] ) );
check( 'a cookie domain from another site is refused (host-only instead)', '' === $plan( array(), 'https://www.example.com.bd/', 'evil.com' )['_fbp']['domain'] && '' === $plan( array(), 'https://www.example.com.bd/', 'bd' )['_fbp']['domain'] && '' === $plan( array(), 'https://www.example.com.bd/', 'ample.com.bd' )['_fbp']['domain'] );
$off = $cfg; $off['meta']['on'] = false; $off['tiktok']['on'] = false;
check( 'pixels off: only the visitor id', array( 'ffc_vid' ) === array_column( FFC_Tracking::cookie_plan( array( 'ffc_vid' => 'abcdefghijkl1234', '_fbp' => 'fb.1.1700000000000.1' ), 'https://www.example.com.bd/', 'www.example.com.bd', '', $off, 1760000000 ), 'name' ) );

echo "\nScenario 13 — coverage: what the pixel missed and the server delivered (last 24h)\n";
unset( $GLOBALS['OPTIONS'][ FFC_Tracking::STATS_OPT ] );
$now = 1760000000;
foreach ( array( '1', '1', '1', '0', '0', '' ) as $i => $pxs ) { FFC_Tracking::stats_add( '202610091200', $pxs, true, 5 !== $i, $now ); }
$minute_n = $GLOBALS['OPTIONS'][ FFC_Tracking::STATS_OPT ]['n'];
FFC_Tracking::stats_add( '202610081200', '0', true, true, $now - 30 * 3600 ); // older than 24h
$sum = FFC_Tracking::first_party_summary( 24, $now );
check( '6 events, 5 with a known pixel state, 2 blocked', 6 === $sum['r'] && 5 === $sum['k'] && 2 === $sum['b'] );
check( 'pixel alone 60%, server 83.3% (1 refused)', 60.0 === $sum['pixel_pct'] && 83.3 === $sum['coverage_pct'] && 1 === $sum['f'] );
check( 'minute counter for the rate limit (6 this minute, back to 1 in a new minute)', 6 === $minute_n && 1 === $GLOBALS['OPTIONS'][ FFC_Tracking::STATS_OPT ]['n'] );
for ( $h = 0; $h < 60; $h++ ) { FFC_Tracking::stats_add( 'm', '1', true, true, $now + $h * 3600 ); }
check( 'keeps 48 hours', 48 === count( $GLOBALS['OPTIONS'][ FFC_Tracking::STATS_OPT ]['h'] ) );

echo "\n$ok passed, $fail failed\n";
exit( $fail ? 1 : 0 );

// The flat form-style array FFC_Tracking::save expects.
function flatten_settings( $s ) {
	return array(
		'meta_on' => $s['meta']['on'] ? '1' : '', 'meta_pixel' => $s['meta']['pixel'], 'meta_token' => $s['meta']['token'], 'meta_test' => $s['meta']['test'],
		'tiktok_on' => $s['tiktok']['on'] ? '1' : '', 'tiktok_pixel' => $s['tiktok']['pixel'], 'tiktok_token' => $s['tiktok']['token'], 'tiktok_test' => $s['tiktok']['test'],
		'google_on' => $s['google']['on'] ? '1' : '', 'google_conv_id' => $s['google']['conv_id'], 'google_conv_label' => $s['google']['conv_label'], 'google_ga4_id' => $s['google']['ga4_id'], 'google_ga4_secret' => $s['google']['ga4_secret'],
		'trigger' => $s['trigger'], 'min_rr' => (string) $s['min_rr'], 'dup_hours' => (string) $s['dup_hours'],
		'exclude_low_rr' => $s['exclude_low_rr'] ? '1' : '', 'skip_duplicates' => $s['skip_duplicates'] ? '1' : '', 'browser_events' => $s['browser_events'] ? '1' : '',
		'server_events' => $s['server_events'] ? '1' : '', 'advanced_matching' => $s['advanced_matching'] ? '1' : '', 'browser_purchase' => $s['browser_purchase'] ? '1' : '',
	);
}
