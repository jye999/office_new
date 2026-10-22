# Notes: quirks and suspected bugs found while porting (do not fix; record)

- api.php product routes outside auth groups were unauthenticated in the old app; new app guards them (roles admin,user,remote). Intentional.
- api.php routes duplicated in web.php are shadowed (web wins); only the web.php version is ported.
- /OrderHistory, /SaveOrder, /UpdateShippedOrder, /ProcessOrders point at non-existent controllers; not ported.
- (T03) The old app has no resources/views/errors/404 view, so with APP_DEBUG=true (its .env) a 404 renders Symfony's detailed debug exception page (PHP traces, request meta). The new app serves the production (non-debug) Symfony 404 page: `<h1>404 | Not Found</h1>` + "Whoops, looks like something went wrong." 404 bodies are therefore not asserted in parity.
- (T03) Laravel 5.4 paginate() JSON has no first_page_url/links keys, and `from` goes negative (e.g. -14 for per_page 15) when total is 0. Ported as-is.
