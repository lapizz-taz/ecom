<?php
// Test helper for track-e2e.cjs, run inside the WordPress container:
//   php track-act.php <setup|rest-confirm|manual|captured|clear|meta> [order_id] [receive_rate|status]
$_SERVER['HTTP_HOST'] = '172.18.0.1:8090'; $_SERVER['REQUEST_URI'] = '/';
require '/var/www/html/wp-load.php';
$action = $argv[1]; $id = isset( $argv[2] ) ? $argv[2] : 0; $rr = isset( $argv[3] ) ? $argv[3] : null;
if ( 'setup' === $action ) { // activate the plugin and turn on all three platforms — no Fullfilio connection
	require_once ABSPATH . 'wp-admin/includes/plugin.php';
	$r = activate_plugin( 'fullfilio-connect/fullfilio-connect.php' );
	echo 'activate: ', is_wp_error( $r ) ? $r->get_error_message() : 'ok', "\n";
	echo 'connected: ', FFC_Settings::connected() ? 'yes' : 'no', "\n";
	FFC_Tracking::save( array(
		'meta_on' => '1', 'meta_pixel' => '111222333', 'meta_token' => 'META_TEST_TOKEN', 'meta_test' => '',
		'tiktok_on' => '1', 'tiktok_pixel' => 'CTEST123', 'tiktok_token' => 'TT_TEST_TOKEN', 'tiktok_test' => '',
		'google_on' => '1', 'google_conv_id' => 'AW-999', 'google_conv_label' => 'lbl', 'google_ga4_id' => 'G-TEST', 'google_ga4_secret' => 'GA4_TEST_SECRET',
		'trigger' => 'confirmed', 'exclude_low_rr' => '1', 'min_rr' => '40', 'browser_events' => '1', 'browser_purchase' => '',
	) );
	delete_option( 'ffc_test_captured' );
	echo 'tracking on: ', FFC_Tracking::any_on() ? 'yes' : 'no', "\n";
} elseif ( 'rest-confirm' === $action ) { // exactly the call Fullfilio makes: POST /fullfilio/v1/order-status
	wp_set_current_user( 1 );
	$req = new WP_REST_Request( 'POST', '/fullfilio/v1/order-status' );
	$req->set_header( 'content-type', 'application/json' );
	$body = array( 'order_id' => (int) $id, 'status' => 'confirmed', 'note' => 'Call confirmed', 'restock' => array(), 'stock_sync' => false );
	if ( null !== $rr ) { $body['receive_rate'] = (float) $rr; }
	$req->set_body( wp_json_encode( $body ) );
	$res = rest_do_request( $req );
	echo wp_json_encode( array( 'http' => $res->get_status(), 'data' => $res->get_data() ) );
} elseif ( 'manual' === $action ) { // the merchant changes the status in WooCommerce → Orders
	wc_get_order( (int) $id )->update_status( $rr ? $rr : 'confirmed', 'Changed by shop manager.' );
	echo wp_json_encode( array( 'status' => wc_get_order( (int) $id )->get_status() ) );
} elseif ( 'captured' === $action ) {
	echo wp_json_encode( get_option( 'ffc_test_captured', array() ) );
} elseif ( 'clear' === $action ) {
	delete_option( 'ffc_test_captured' ); echo '{}';
} elseif ( 'meta' === $action ) {
	$o = wc_get_order( (int) $id );
	echo wp_json_encode( array( 'status' => $o->get_status(), 'attr' => json_decode( (string) $o->get_meta( '_ffc_attribution' ), true ), 'rr' => $o->get_meta( '_ffc_receive_rate' ), 'sent' => $o->get_meta( '_ffc_track_sent' ) ) );
}
