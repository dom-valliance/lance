# apache/age:PG16_latest does not exist on Docker Hub; release_PG16_1.6.0 is the
# newest PostgreSQL 16 release tag and matches the AGE 1.6 decision in ADR 0004.
FROM apache/age:release_PG16_1.6.0

# The base image is the official postgres image with AGE built in, so the PGDG
# apt repository is already configured. Add pgvector from the same repository.
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16-pgvector \
    && rm -rf /var/lib/apt/lists/*
