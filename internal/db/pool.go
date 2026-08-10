package db

import (
	"database/sql"
	"time"
)

// Pool describes the database/sql connection pool applied to external
// databases (MariaDB/MySQL, PostgreSQL). SQLite ignores it and always runs on a
// single connection.
type Pool struct {
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
	ConnMaxIdleTime time.Duration
}

// DefaultPool returns the historical pool sizing, used when a caller does not
// provide its own configuration.
func DefaultPool() Pool {
	return Pool{
		MaxOpenConns:    10,
		MaxIdleConns:    5,
		ConnMaxLifetime: 30 * time.Minute,
		ConnMaxIdleTime: 5 * time.Minute,
	}
}

// normalized repairs a zero or inconsistent pool so callers can never install a
// pool that database/sql would silently reinterpret.
func (p Pool) normalized() Pool {
	// A caller that supplies nothing gets the defaults. A caller that supplies
	// anything keeps its explicit zeros, because "no idle connections" and
	// "unlimited lifetime" are legitimate choices.
	if p == (Pool{}) {
		return DefaultPool()
	}
	if p.MaxOpenConns <= 0 {
		p.MaxOpenConns = DefaultPool().MaxOpenConns
	}
	if p.MaxIdleConns < 0 {
		p.MaxIdleConns = 0
	}
	if p.MaxIdleConns > p.MaxOpenConns {
		p.MaxIdleConns = p.MaxOpenConns
	}
	if p.ConnMaxLifetime < 0 {
		p.ConnMaxLifetime = 0
	}
	if p.ConnMaxIdleTime < 0 {
		p.ConnMaxIdleTime = 0
	}
	if p.ConnMaxLifetime > 0 && p.ConnMaxIdleTime > p.ConnMaxLifetime {
		p.ConnMaxIdleTime = p.ConnMaxLifetime
	}
	return p
}

func (p Pool) apply(database *sql.DB) {
	database.SetMaxOpenConns(p.MaxOpenConns)
	database.SetMaxIdleConns(p.MaxIdleConns)
	database.SetConnMaxLifetime(p.ConnMaxLifetime)
	database.SetConnMaxIdleTime(p.ConnMaxIdleTime)
}
