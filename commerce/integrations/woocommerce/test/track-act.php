<?php
// Test helper for track-e2e.cjs, run inside the WordPress container:
//   php track-act.php <setup|mode|rest-confirm|manual|captured|clear|meta|status|update-check|upgrade> [arg] [arg]
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
		'skip_duplicates' => '1', 'dup_hours' => '24', 'server_events' => '1', 'advanced_matching' => '1',
	) );
	foreach ( array( 'ffc_test_captured', FFC_Tracking::LOG_OPT, FFC_Tracking::SEEN_OPT, FFC_Tracking::STATUS_OPT ) as $o ) {
		delete_option( $o );
	}
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
} elseif ( 'mode' === $action ) { // switch "When the Purchase counts"
	$s = get_option( FFC_Tracking::OPTION );
	$s['trigger'] = $id;
	update_option( FFC_Tracking::OPTION, $s, false );
	echo wp_json_encode( array( 'trigger' => FFC_Tracking::settings()['trigger'] ) );
} elseif ( 'status' === $action ) {
	echo wp_json_encode( array( 'meta' => FFC_Tracking::status( 'meta' ), 'tiktok' => FFC_Tracking::status( 'tiktok' ), 'google' => FFC_Tracking::status( 'google' ) ) );
} elseif ( 'update-check' === $action ) { // what WordPress's update check does
	FFC_Updater::manifest( true );
	delete_site_transient( 'update_plugins' );
	wp_update_plugins();
	$t = get_site_transient( 'update_plugins' );
	$f = plugin_basename( FFC_FILE );
	echo wp_json_encode( array( 'available' => FFC_Updater::available(), 'response' => isset( $t->response[ $f ] ) ? $t->response[ $f ] : null ) );
} elseif ( 'upgrade' === $action ) { // Plugins → Update now, without a browser
	require_once ABSPATH . 'wp-admin/includes/admin.php';
	require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
	wp_set_current_user( 1 );
	$skin = new Automatic_Upgrader_Skin();
	$r    = ( new Plugin_Upgrader( $skin ) )->upgrade( plugin_basename( FFC_FILE ) );
	$data = get_plugin_data( WP_PLUGIN_DIR . '/fullfilio-connect/fullfilio-connect.php', false, false );
	echo wp_json_encode( array( 'result' => is_wp_error( $r ) ? $r->get_error_code() : $r, 'errors' => is_wp_error( $skin->result ) ? $skin->result->get_error_codes() : array(), 'messages' => $skin->get_upgrade_messages(), 'version' => $data['Version'] ) );
} elseif ( 'captured' === $action ) {
	echo wp_json_encode( get_option( 'ffc_test_captured', array() ) );
} elseif ( 'clear' === $action ) {
	delete_option( 'ffc_test_captured' ); echo '{}';
} elseif ( 'meta-full' === $action ) {
	$o = wc_get_order( (int) $id );
	echo wp_json_encode( array( 'skip' => $o->get_meta( '_ffc_track_skip' ), 'decision' => $o->get_meta( '_ffc_track_decision' ) ) );
} elseif ( 'meta' === $action ) {
	$o = wc_get_order( (int) $id );
	echo wp_json_encode( array( 'status' => $o->get_status(), 'attr' => json_decode( (string) $o->get_meta( '_ffc_attribution' ), true ), 'rr' => $o->get_meta( '_ffc_receive_rate' ), 'sent' => $o->get_meta( '_ffc_track_sent' ) ) );
}
