<?php
/**
 * Plugin Name: UlixOps broken fixture
 * Description: TEST SITE ONLY. Activates cleanly, then crashes every request (front end, wp-admin and plain WP-CLI) until it is deactivated. Lets UlixOps check its emergency actions against a broken site.
 * Version: 1.0.0
 */

if (!defined('ABSPATH')) {
    exit;
}

// WordPress loads a plugin once before marking it active, so activation itself succeeds.
if (in_array(plugin_basename(__FILE__), (array) get_option('active_plugins', []), true)) {
    ulixops_fixture_undefined_function();
}
