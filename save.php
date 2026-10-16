<?php
// Lets the app save downloaded sessions into data/. Local machine only; JSON files under data/ only.
// GET ?probe -> 204 (the app uses this to detect saving support). POST ?f=<year>/<session_key>/<name>.json (body = JSON).
$ip = $_SERVER['REMOTE_ADDR'] ?? '';
if ($ip !== '127.0.0.1' && $ip !== '::1') { http_response_code(403); exit; }
$host = preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? '');
if ($host !== 'localhost' && $host !== '127.0.0.1') { http_response_code(403); exit; } // DNS-rebinding guard
if (isset($_GET['probe'])) { http_response_code(204); exit; }
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { http_response_code(405); exit; }
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && parse_url($origin, PHP_URL_HOST) . (parse_url($origin, PHP_URL_PORT) ? ':' . parse_url($origin, PHP_URL_PORT) : '') !== ($_SERVER['HTTP_HOST'] ?? '')) { http_response_code(403); exit; }
$f = $_GET['f'] ?? '';
if (!preg_match('~^(\d{4}/\d+/|circuits/)?[\w.-]+\.json$~', $f) || strpos($f, '..') !== false) { http_response_code(400); exit; }
$body = file_get_contents('php://input');
json_decode($body);
if ($body === '' || json_last_error() !== JSON_ERROR_NONE) { http_response_code(400); exit; }
$path = __DIR__ . '/data/' . $f;
if (!is_dir(dirname($path)) && !mkdir(dirname($path), 0777, true)) { http_response_code(500); exit; }
http_response_code(file_put_contents($path, $body) === false ? 500 : 204);
