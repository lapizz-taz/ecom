<?php
/**
 * The outbox: every event for Fullfilio is written here first and sent from
 * the queue, so a slow or unreachable Fullfilio never slows the checkout and
 * nothing is lost while it is down.
 *
 * - Each event keeps one id for all its attempts; Fullfilio ignores an id it
 *   has already handled, so a retry never creates a duplicate.
 * - Failed sends wait longer each time (30 s … 12 h) and stop after 10 tries;
 *   they stay listed on the plugin page and can be sent again by hand.
 * - Fullfilio rejecting an event as invalid (4xx) is not retried.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Outbox {
	const DB_VERSION   = '1';
	const MAX_ATTEMPTS = 10;
	const BATCH        = 25;
	const HOOK         = 'ffc_outbox_flush';

	/** Seconds to wait after attempt n (1-based). */
	const BACKOFF = array( 30, 120, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200 );

	public static function table() {
		global $wpdb;
		return $wpdb->prefix . 'ffc_outbox';
	}

	public static function install() {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table   = self::table();
		$charset = $wpdb->get_charset_collate();
		dbDelta(
			"CREATE TABLE {$table} (
			id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
			event_id char(36) NOT NULL,
			type varchar(40) NOT NULL,
			payload longtext NOT NULL,
			status varchar(12) NOT NULL DEFAULT 'pending',
			attempts smallint(5) unsigned NOT NULL DEFAULT 0,
			next_at datetime NOT NULL,
			last_error text NULL,
			last_status smallint(5) unsigned NULL,
			created_at datetime NOT NULL,
			sent_at datetime NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY event_id (event_id),
			KEY due (status, next_at)
			) {$charset};"
		);
		update_option( 'ffc_db_version', self::DB_VERSION, true );
	}

	public static function maybe_upgrade() {
		if ( get_option( 'ffc_db_version' ) !== self::DB_VERSION ) {
			self::install();
		}
		add_action( self::HOOK, array( __CLASS__, 'flush' ) );
	}

	/**
	 * Queues an event and asks for a send right after this request.
	 *
	 * @return string The event id.
	 */
	public static function push( $type, $payload, $event_id = null ) {
		global $wpdb;
		$event_id = $event_id ? $event_id : FFC_Signer::uuid();
		$now      = gmdate( 'Y-m-d H:i:s' );
		$wpdb->query(
			$wpdb->prepare(
				'INSERT IGNORE INTO ' . self::table() . ' (event_id, type, payload, status, attempts, next_at, created_at) VALUES (%s, %s, %s, %s, 0, %s, %s)', // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
				$event_id,
				$type,
				wp_json_encode( $payload ),
				'pending',
				$now,
				$now
			)
		);
		self::kick();
		return $event_id;
	}

	/**
	 * Runs the queue at $at (now by default): Action Scheduler when WooCommerce has it, else a
	 * one-off WP-Cron event. An earlier run already planned is kept; a later one is moved forward.
	 */
	public static function kick( $at = 0 ) {
		$at = max( time(), (int) $at );
		if ( function_exists( 'as_next_scheduled_action' ) && function_exists( 'as_schedule_single_action' ) ) {
			$next = as_next_scheduled_action( self::HOOK, array(), 'fullfilio' );
			if ( true === $next || ( is_int( $next ) && $next <= $at ) ) {
				return;
			}
			if ( is_int( $next ) ) {
				as_unschedule_action( self::HOOK, array(), 'fullfilio' );
			}
			if ( $at <= time() && function_exists( 'as_enqueue_async_action' ) ) {
				as_enqueue_async_action( self::HOOK, array(), 'fullfilio' );
			} else {
				as_schedule_single_action( $at, self::HOOK, array(), 'fullfilio' );
			}
			return;
		}
		$next = wp_next_scheduled( self::HOOK );
		if ( $next && $next <= $at ) {
			return;
		}
		if ( $next ) {
			wp_unschedule_event( $next, self::HOOK );
		}
		wp_schedule_single_event( $at, self::HOOK );
	}

	/** Sends due events. Safe to run from several places at once (rows are claimed first). */
	public static function flush( $limit = self::BATCH ) {
		global $wpdb;
		if ( ! FFC_Settings::connected() ) {
			return array( 'sent' => 0, 'failed' => 0, 'waiting' => 0 );
		}
		$table = self::table();
		$now   = gmdate( 'Y-m-d H:i:s' );
		$rows  = $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$table} WHERE status = 'pending' AND next_at <= %s ORDER BY id ASC LIMIT %d", $now, $limit ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
		$out   = array( 'sent' => 0, 'failed' => 0, 'waiting' => 0 );
		foreach ( $rows as $row ) {
			// Claim the row: another worker that read it too will not update it.
			$claimed = $wpdb->query(
				$wpdb->prepare( "UPDATE {$table} SET status = 'sending', attempts = attempts + 1, next_at = %s WHERE id = %d AND status = 'pending'", gmdate( 'Y-m-d H:i:s' ), $row['id'] ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			);
			if ( 1 !== (int) $claimed ) {
				continue;
			}
			$attempt = (int) $row['attempts'] + 1;
			$payload = json_decode( $row['payload'], true );
			$result  = FFC_Api::send( $row['type'], is_array( $payload ) ? $payload : array(), $row['event_id'] );
			if ( $result['ok'] ) {
				$wpdb->update(
					$table,
					array( 'status' => 'sent', 'sent_at' => gmdate( 'Y-m-d H:i:s' ), 'last_status' => $result['status'], 'last_error' => null ),
					array( 'id' => $row['id'] )
				);
				++$out['sent'];
				continue;
			}
			$final = ! $result['retry'] || $attempt >= self::MAX_ATTEMPTS;
			$wait  = self::BACKOFF[ min( $attempt, count( self::BACKOFF ) ) - 1 ];
			$wpdb->update(
				$table,
				array(
					'status'      => $final ? 'failed' : 'pending',
					'next_at'     => gmdate( 'Y-m-d H:i:s', time() + $wait ),
					'last_error'  => substr( (string) $result['error'], 0, 500 ),
					'last_status' => $result['status'],
				),
				array( 'id' => $row['id'] )
			);
			if ( $final ) {
				++$out['failed'];
				FFC_Log::error( sprintf( 'Could not send %s after %d tries: %s', $row['type'], $attempt, $result['error'] ), array( 'event' => $row['event_id'] ) );
			} else {
				++$out['waiting'];
				FFC_Log::warning( sprintf( 'Sending %s failed (try %d), retrying in %s: %s', $row['type'], $attempt, human_time_diff( time(), time() + $wait ), $result['error'] ), array( 'event' => $row['event_id'] ) );
			}
		}
		// Rows left "sending" by a request that died mid-way go back in the queue after 10 minutes.
		$wpdb->query(
			$wpdb->prepare( "UPDATE {$table} SET status = 'pending' WHERE status = 'sending' AND next_at < %s", gmdate( 'Y-m-d H:i:s', time() - 600 ) ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		// Keep a week of sent events for the debug view.
		$wpdb->query(
			$wpdb->prepare( "DELETE FROM {$table} WHERE status = 'sent' AND sent_at < %s", gmdate( 'Y-m-d H:i:s', time() - WEEK_IN_SECONDS ) ) // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		);
		// Plan the next run for the earliest waiting event, so a retry happens on time and not only
		// with the next order or the 15-minute heartbeat.
		$next = $wpdb->get_var( "SELECT MIN(next_at) FROM {$table} WHERE status = 'pending'" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		if ( $next ) {
			self::kick( strtotime( $next . ' UTC' ) );
		}
		return $out;
	}

	public static function due_count() {
		global $wpdb;
		$table = self::table();
		return (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$table} WHERE status = 'pending' AND next_at <= %s", gmdate( 'Y-m-d H:i:s' ) ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	}

	/** Counts for the health report and the plugin page. */
	public static function stats() {
		global $wpdb;
		$table = self::table();
		$rows  = $wpdb->get_results( "SELECT status, COUNT(*) AS n, MIN(created_at) AS oldest FROM {$table} GROUP BY status", ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$out   = array( 'pending' => 0, 'sending' => 0, 'failed' => 0, 'sent' => 0, 'oldest_pending' => null );
		foreach ( (array) $rows as $r ) {
			$out[ $r['status'] ] = (int) $r['n'];
			if ( 'pending' === $r['status'] ) {
				$out['oldest_pending'] = $r['oldest'] ? gmdate( 'c', strtotime( $r['oldest'] . ' UTC' ) ) : null;
			}
		}
		return $out;
	}

	/** @return array<int, array> Latest events, newest first (no payloads). */
	public static function recent( $limit = 30 ) {
		global $wpdb;
		$table = self::table();
		return (array) $wpdb->get_results(
			$wpdb->prepare( "SELECT id, event_id, type, status, attempts, next_at, last_error, last_status, created_at, sent_at FROM {$table} ORDER BY id DESC LIMIT %d", $limit ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			ARRAY_A
		);
	}

	/** Puts failed events back in the queue (button on the plugin page). */
	public static function retry_failed() {
		global $wpdb;
		$table = self::table();
		$n     = $wpdb->query( $wpdb->prepare( "UPDATE {$table} SET status = 'pending', attempts = 0, next_at = %s WHERE status = 'failed'", gmdate( 'Y-m-d H:i:s' ) ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		self::kick();
		return (int) $n;
	}
}
