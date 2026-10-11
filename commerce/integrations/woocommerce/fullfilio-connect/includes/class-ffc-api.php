<?php
/**
 * Talks to Fullfilio: POST <endpoint>/plugin/<channel id> with a signed JSON body.
 *
 * Headers: X-FFC-Event (type), X-FFC-Event-Id (same on every retry),
 * X-FFC-Timestamp and X-FFC-Signature (see FFC_Signer), X-FFC-Version.
 */

defined( 'ABSPATH' ) || exit;

class FFC_Api {
	/**
	 * One signed request.
	 *
	 * @return array{ok:bool,status:int,retry:bool,error:string,body:array}
	 */
	public static function send( $type, $payload, $event_id = null, $timeout = 15 ) {
		$c = FFC_Settings::connection();
		if ( ! $c ) {
			return array( 'ok' => false, 'status' => 0, 'retry' => true, 'error' => 'Not connected to Fullfilio', 'body' => array() );
		}
		$body = wp_json_encode(
			array(
				'type'    => $type,
				'site'    => home_url(),
				'sent_at' => gmdate( 'c' ),
				'data'    => $payload,
			)
		);
		$ts       = (string) time();
		$event_id = $event_id ? $event_id : FFC_Signer::uuid();
		$response = wp_remote_post(
			$c['endpoint'] . '/plugin/' . rawurlencode( $c['channel_id'] ),
			array(
				'timeout'     => $timeout,
				'redirection' => 0,
				'headers'     => array(
					'Content-Type'    => 'application/json',
					'X-FFC-Event'     => $type,
					'X-FFC-Event-Id'  => $event_id,
					'X-FFC-Timestamp' => $ts,
					'X-FFC-Signature' => FFC_Signer::sign( $c['secret'], $ts, $body ),
					'X-FFC-Version'   => FFC_VERSION,
				),
				'body'        => $body,
			)
		);
		if ( is_wp_error( $response ) ) {
			$error = $response->get_error_message();
			self::note_result( false, $error );
			return array( 'ok' => false, 'status' => 0, 'retry' => true, 'error' => $error, 'body' => array() );
		}
		$status = (int) wp_remote_retrieve_response_code( $response );
		$json   = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		$json   = is_array( $json ) ? $json : array();
		if ( $status >= 200 && $status < 300 ) {
			if ( isset( $json['config'] ) && is_array( $json['config'] ) ) {
				FFC_Settings::save_config( $json['config'] );
			}
			self::note_result( true, '' );
			return array( 'ok' => true, 'status' => $status, 'retry' => false, 'error' => '', 'body' => $json );
		}
		$message = isset( $json['error']['message'] ) ? (string) $json['error']['message'] : 'HTTP ' . $status;
		if ( 401 === $status ) {
			$message = 'Fullfilio did not accept this site\'s signature — connect the store again from Fullfilio. (' . $message . ')';
		}
		// Timeouts, rate limits and server errors are worth another try; a refused event is not.
		$retry = 0 === $status || 408 === $status || 429 === $status || $status >= 500;
		self::note_result( false, $message );
		return array( 'ok' => false, 'status' => $status, 'retry' => $retry, 'error' => $message, 'body' => $json );
	}

	private static function note_result( $ok, $error ) {
		if ( $ok ) {
			FFC_Settings::set_state( array( 'last_ok_at' => gmdate( 'c' ), 'last_error' => '' ) );
		} else {
			FFC_Settings::set_state( array( 'last_error' => substr( $error, 0, 300 ), 'last_error_at' => gmdate( 'c' ) ) );
		}
	}
}
