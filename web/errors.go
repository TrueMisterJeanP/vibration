package webassets

import _ "embed"

var (
	//go:embed 404.html
	notFoundPage []byte

	//go:embed 429.html
	tooManyRequestsPage []byte
)

// ErrorPage returns a copy of the standalone branded page embedded in the
// server binary. The deployed WEB_DIR files remain the primary source so they
// can still be updated without recompiling the application.
func ErrorPage(status int) []byte {
	var page []byte
	switch status {
	case 404:
		page = notFoundPage
	case 429:
		page = tooManyRequestsPage
	default:
		return nil
	}
	return append([]byte(nil), page...)
}
