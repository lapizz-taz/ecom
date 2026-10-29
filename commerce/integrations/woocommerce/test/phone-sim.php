<?php
/**
 * The plugin's phone rules (FFC_Protect::normalize_phone) against the same table Fullfilio checks
 * itself with (supabase/tests/db/phone-forms.test.ts): what customers type, and what is kept.
 * Run: php integrations/woocommerce/test/phone-sim.php
 */

define( 'ABSPATH', __DIR__ . '/' );
require __DIR__ . '/../fullfilio-connect/includes/class-ffc-protect.php';

$ok = 0; $fail = 0;
function check( $label, $cond ) {
	global $ok, $fail;
	if ( $cond ) { $ok++; echo "  PASS  $label\n"; } else { $fail++; echo "  FAIL  $label\n"; }
}

$cases = array(
	// Accepted before, and kept the same.
	array( '01712278464', '01712278464' ),
	array( '+880 1712-278464', '01712278464' ),
	array( '8801712278464', '01712278464' ),
	array( '008801712278464', '01712278464' ),
	array( '01712 278 464', '01712278464' ),
	array( '1712278464', '01712278464' ),
	// Accepted now.
	array( '+88 1712278464', '01712278464' ),
	array( '+880 01712278464', '01712278464' ),
	array( '0088 01712278464', '01712278464' ),
	array( '+88 01712278464', '01712278464' ),
	array( '০১৭১২২৭৮৪৬৪', '01712278464' ),
	array( '+৮৮০ ১৭১২-২৭৮৪৬৪', '01712278464' ),
	array( '01712-278464 / 01812-000000', '01712278464' ),
	array( '01712278464, 01812000000', '01712278464' ),
	array( '+8801712278464 or +8801812000000', '01712278464' ),
	// Still refused.
	array( '12345', null ),
	array( '01212278464', null ),
	array( '017122784', null ),
	array( '', null ),
);

echo "Phone numbers as customers type them\n";
foreach ( $cases as $c ) {
	$got = FFC_Protect::normalize_phone( $c[0] );
	check( sprintf( '%-34s → %s', "'" . $c[0] . "'", null === $c[1] ? 'refused' : $c[1] ), $got === $c[1] );
}

echo "\n$ok passed, $fail failed\n";
exit( $fail ? 1 : 0 );
