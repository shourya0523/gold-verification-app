# Gold verification app

Static web app for the team checking gold revenue rows against their sources.
It talks to the `gold-verification` Supabase project named in `config.js`.

Deploy as plain static files: no framework and no build command; the output
directory is the repository root.

The source of truth is `tools/verification-app/` in
`shourya0523/pharma-analog-uptake-workbench`. That directory holds the
Supabase schema, the preview Edge Function, the gold row builder, the tests
and the full README; this repository carries a copy of its `web/` folder for
hosting.
