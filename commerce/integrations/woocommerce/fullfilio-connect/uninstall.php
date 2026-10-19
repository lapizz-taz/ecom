<?php
/**
 * Removing the plugin removes its settings, log and queue. Orders and their
 * attribution notes stay with the orders.
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

foreach ( array( 'ffc_connection', 'ffc_config', 'ffc_state', 'ffc_log', 'ffc_db_version', 'ffc_tracking', 'ffc_track_status', 'ffc_track_seen', 'ffc_track_log', 'ffc_fp_route', 'ffc_fp_stats' ) as $option ) {
	delete_option( $option );
}
wp_clear_scheduled_hook( 'ffc_heartbeat' );
wp_clear_scheduled_hook( 'ffc_outbox_flush' );

global $wpdb;
$wpdb->query( 'DROP TABLE IF EXISTS ' . $wpdb->prefix . 'ffc_outbox' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.SchemaChange
