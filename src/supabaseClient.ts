import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Without this, a fresh clone with an unfilled .env.local dies inside
// createClient with a message that says nothing about the real problem.
// This is the most likely first-run failure for anyone cloning the repo.
if (!supabaseUrl || !supabaseAnonKey) {
  const missing = [
    !supabaseUrl && 'VITE_SUPABASE_URL',
    !supabaseAnonKey && 'VITE_SUPABASE_ANON_KEY'
  ].filter(Boolean).join(' and ')

  throw new Error(
    `Missing ${missing}.\n\n` +
      'Copy .env.example to .env.local and fill in your Supabase project details:\n' +
      '  VITE_SUPABASE_URL      Settings → Data API → Project URL\n' +
      '  VITE_SUPABASE_ANON_KEY Settings → API Keys → Publishable key\n\n' +
      'Then restart the dev server. Vite only reads .env files at startup.'
  )
}

// This key is meant to be public; it ships in the JS bundle. Row-level
// security is what actually protects the data, and it only holds if public
// sign-ups are disabled. See the Security section in README.md.
export const supabase = createClient(supabaseUrl, supabaseAnonKey)
