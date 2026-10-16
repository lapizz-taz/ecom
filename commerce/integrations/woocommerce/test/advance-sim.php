<?php
/**
 * Offline simulation of FFC_Advance with the real FFC_Checkout and FFC_Settings:
 * Fullfilio's answer (stubbed FFC_Api) → delivery level → the store's rule for
 * that level → the advance, the "pay on delivery" rest, and what the checkout
 * refuses. No WordPress, no network.
 * Run: php integrations/woocommerce/test/advance-sim.php
 */

define( 'ABSPATH', __DIR__ . '/' );
define( 'FFC_VERSION', '1.5.0' );
define( 'FFC_URL', 'https://shop.test/wp-content/plugins/fullfilio-connect/' );
define( 'MINUTE_IN_SECONDS', 60 );
define( 'HOUR_IN_SECONDS', 3600 );

$GLOBALS['OPTIONS']    = array();
$GLOBALS['TRANSIENTS'] = array();
$GLOBALS['CALLS']      = array();
$GLOBALS['ANSWER']     = array( 'ok' => true, 'body' => array( 'decision' => 'allow', 'reason' => 'ALLOW' ) );

function __( $s ) { return $s; }
function add_action() {}
function add_filter() {}
function get_option( $k, $d = false ) { return array_key_exists( $k, $GLOBALS['OPTIONS'] ) ? $GLOBALS['OPTIONS'][ $k ] : $d; }
function update_option( $k, $v, $a = true ) { $GLOBALS['OPTIONS'][ $k ] = $v; return true; }
function get_transient( $k ) { return isset( $GLOBALS['TRANSIENTS'][ $k ] ) ? $GLOBALS['TRANSIENTS'][ $k ] : false; }
function set_transient( $k, $v, $t ) { $GLOBALS['TRANSIENTS'][ $k ] = $v; return true; }
function wp_strip_all_tags( $s ) { return strip_tags( (string) $s ); }
function wp_json_encode( $d ) { return json_encode( $d ); }
function wc_format_decimal( $n, $dp = 2 ) { return number_format( (float) $n, $dp, '.', '' ); }
function get_woocommerce_currency_symbol() { return '&#2547;'; }
function wc_get_price_decimals() { return 0; }
function esc_url_raw( $u ) { return $u; }
function sanitize_text_field( $s ) { return trim( (string) $s ); }
class WP_Error {}
class FFC_Log { public static function warning( $m, $c = array() ) {} public static function info( $m, $c = array() ) {} }
class FFC_Api {
	public static function send( $type, $payload, $event_id = null, $timeout = 15 ) {
		$GLOBALS['CALLS'][] = array( $type, $payload );
		$a = $GLOBALS['ANSWER'];
		return array( 'ok' => $a['ok'], 'status' => $a['ok'] ? 200 : 0, 'retry' => ! $a['ok'], 'error' => $a['ok'] ? '' : 'timeout', 'body' => $a['ok'] ? $a['body'] : array() );
	}
}
class SimSession {
	public $data = array();
	public function get( $k, $d = null ) { return array_key_exists( $k, $this->data ) ? $this->data[ $k ] : $d; }
	public function set( $k, $v ) { $this->data[ $k ] = $v; }
}
class SimWC { public $session; public $cart = null; public function __construct() { $this->session = new SimSession(); } }
$GLOBALS['WC'] = new SimWC();
function WC() { return $GLOBALS['WC']; }

require __DIR__ . '/../fullfilio-connect/includes/class-ffc-settings.php';
require __DIR__ . '/../fullfilio-connect/includes/class-ffc-checkout.php';
require __DIR__ . '/../fullfilio-connect/includes/class-ffc-advance.php';

$ok = 0; $fail = 0;
function check( $label, $cond ) {
	global $ok, $fail;
	if ( $cond ) { $ok++; echo "  ok   $label\n"; } else { $fail++; echo "  FAIL $label\n"; }
}
function answer( $body, $ok = true ) {
	$GLOBALS['ANSWER'] = array( 'ok' => $ok, 'body' => $body );
	$GLOBALS['TRANSIENTS'] = array();
}

// A connected store with the order shield on and the advance on.
update_option( FFC_Settings::CONNECTION, array( 'endpoint' => 'https://fn.test', 'channel_id' => '00000000-0000-4000-8000-000000000001', 'secret' => str_repeat( 'k', 40 ) ) );
update_option( FFC_Settings::CONFIG, array( 'shield' => true, 'shield_fail_open' => true ) );
FFC_Advance::save( array(
	'enabled' => '1', 'hide_cod' => '1',
	'rule_GOOD' => 'cod', 'rule_MID' => 'delivery', 'rule_LOW' => 'percent_order', 'value_LOW' => '25',
	'rule_NEW' => 'fixed', 'value_NEW' => '150', 'rule_ERROR' => 'percent_delivery', 'value_ERROR' => '50',
	'gateways' => array( 'bkash', 'cod', 'sslcommerz' ),
) );

echo "Rules\n";
check( 'on with the shield', FFC_Advance::on() );
$s = FFC_Advance::settings();
check( 'cash on delivery never takes an advance', ! in_array( 'cod', $s['gateways'], true ) );
check( 'delivery rule ignores a value', 0.0 === (float) $s['rules']['MID']['value'] );
check( 'rule amounts', 120.0 === FFC_Advance::rule_amount( 'delivery', 0, 1370, 120 ) && 342.5 === FFC_Advance::rule_amount( 'percent_order', 25, 1370, 120 )
	&& 60.0 === FFC_Advance::rule_amount( 'percent_delivery', 50, 1370, 120 ) && 150.0 === FFC_Advance::rule_amount( 'fixed', 150, 1370, 120 ) && 0.0 === FFC_Advance::rule_amount( 'cod', 0, 1370, 120 ) );
$p = FFC_Advance::plan( array( 'decision' => 'allow', 'level' => 'GOOD' ), 1370, 120 );
check( 'GOOD: cash on delivery', 0.0 === (float) $p['advance'] && 0.0 === (float) $p['due'] );
$p = FFC_Advance::plan( array( 'decision' => 'allow', 'level' => 'MID' ), 1370, 120 );
check( 'MID: the delivery charge now, the rest on delivery', 120.0 === (float) $p['advance'] && 1250.0 === (float) $p['due'] );
$p = FFC_Advance::plan( array( 'decision' => 'allow', 'level' => 'LOW' ), 1370, 120 );
check( 'LOW: 25% rounded up to a whole amount', 343.0 === (float) $p['advance'] && 1027.0 === (float) $p['due'] );
$p = FFC_Advance::plan( array( 'decision' => 'allow', 'level' => 'NEW' ), 100, 0 );
check( 'never more than the order (then paid in full, nothing on delivery)', 100.0 === (float) $p['advance'] && 0.0 === (float) $p['due'] );
$p = FFC_Advance::plan( array( 'decision' => 'advance', 'level' => 'GOOD', 'advance_amount' => 200 ), 1370, 120 );
check( 'Fullfilio\'s own advance applies even for a GOOD level', 200.0 === (float) $p['advance'] );
$p = FFC_Advance::plan( array( 'decision' => 'advance', 'level' => 'LOW', 'advance_amount' => 200 ), 1370, 120 );
check( 'the larger of the two applies', 343.0 === (float) $p['advance'] );
$p = FFC_Advance::plan( array( 'decision' => 'allow', 'level' => '' ), 1370, 120 );
check( 'no level (shield off or paused): no advance', 0.0 === (float) $p['advance'] );
check( 'only the chosen online methods take it', FFC_Advance::is_advance_gateway( 'bkash' ) && ! FFC_Advance::is_advance_gateway( 'nagad' ) && ! FFC_Advance::is_advance_gateway( 'cod' ) && ! FFC_Advance::is_advance_gateway( '' ) );

echo "Fullfilio's answer\n";
answer( array( 'decision' => 'allow', 'reason' => 'ALLOW', 'level' => array( 'tier' => 'MID', 'rate' => 64, 'parcels' => 11 ), 'levels' => array( 'good_min' => 85, 'mid_min' => 55, 'min_parcels' => 2 ) ) );
$d = FFC_Checkout::decision( '01712-345678', 1370, 'bkash', 'Mirpur' );
check( 'level read from the answer', 'MID' === $d['level'] && 'allow' === $d['decision'] );
check( 'the store\'s thresholds are kept for the plugin page', 85.0 === (float) FFC_Advance::levels()['good_min'] );
FFC_Checkout::decision( '01712345678', 1370, 'cod', 'Mirpur' );
check( 'one lookup per phone and order value, whatever the payment method', 1 === count( $GLOBALS['CALLS'] ) );
answer( array( 'decision' => 'allow', 'reason' => 'CHECK_PENDING' ) );
check( 'a check still running counts as "couldn\'t check"', 'ERROR' === FFC_Checkout::decision( '01712345679', 1370, '', '' )['level'] );
answer( array(), false );
check( 'Fullfilio unreachable (fail open): "couldn\'t check"', 'ERROR' === FFC_Checkout::decision( '01712345670', 1370, '', '' )['level'] );
answer( array( 'decision' => 'allow', 'reason' => 'OFF' ) );
check( 'shield off in Fullfilio: no level', '' === FFC_Checkout::decision( '01712345671', 1370, '', '' )['level'] );
answer( array( 'decision' => 'advance', 'reason' => 'ADVANCE', 'advance_amount' => 120, 'level' => array( 'tier' => 'LOW' ) ) );
$d = FFC_Checkout::decision( '01712345672', 1370, '', '' );
check( 'Fullfilio\'s advance amount is read', 120.0 === $d['advance_amount'] && 'advance' === $d['decision'] );

echo "Placing the order\n";
answer( array( 'decision' => 'allow', 'reason' => 'ALLOW', 'level' => array( 'tier' => 'MID' ) ) );
$e = FFC_Advance::verdict( '01811111111', 'cod', '', 1370, 120, 0, 1370 );
check( 'cash on delivery refused, with the amounts', false !== strpos( $e, "\u{09F3}120" ) && false !== strpos( $e, "\u{09F3}1,250" ) );
check( 'the level is remembered for the checkout', 'MID' === WC()->session->get( FFC_Advance::SESSION )['level'] );
check( 'an offline method is refused too', '' !== FFC_Advance::verdict( '01811111111', 'bacs', '', 1370, 120, 0, 1370 ) );
check( 'an online method paying the whole order is fine', '' === FFC_Advance::verdict( '01811111111', 'bkash', '', 1370, 120, 0, 1370 ) );
check( 'an online method paying the advance (rest as the fee line) is fine', '' === FFC_Advance::verdict( '01811111111', 'bkash', '', 1370, 120, -1250, 120 ) );
check( 'a payment smaller than the advance is refused', false !== strpos( FFC_Advance::verdict( '01811111111', 'bkash', '', 1370, 120, -1300, 70 ), 'now' ) );
check( 'the fee line with cash on delivery is refused', '' !== FFC_Advance::verdict( '01811111111', 'cod', '', 1370, 120, -1250, 120 ) );
answer( array( 'decision' => 'allow', 'reason' => 'ALLOW', 'level' => array( 'tier' => 'GOOD' ) ) );
check( 'a GOOD customer may pay cash on delivery', '' === FFC_Advance::verdict( '01822222222', 'cod', '', 1370, 120, 0, 1370 ) );
answer( array( 'decision' => 'block', 'reason' => 'BLOCK_LIST', 'message' => 'No.' ) );
check( 'a blocked customer is left to the order shield', '' === FFC_Advance::verdict( '01833333333', 'cod', '', 1370, 120, 0, 1370 ) );

echo "Switched off\n";
FFC_Advance::save( array( 'enabled' => '' ) );
check( 'off: nothing applies', ! FFC_Advance::on() );
FFC_Advance::save( array( 'enabled' => '1' ) );
update_option( FFC_Settings::CONFIG, array( 'shield' => false ) );
check( 'on but the order shield is off: nothing applies', ! FFC_Advance::on() );

echo "\n$ok passed, $fail failed\n";
exit( $fail ? 1 : 0 );
