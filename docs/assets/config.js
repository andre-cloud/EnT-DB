/* Site configuration. Both values are public by design: the anon key only
 * grants what the database's row-level security allows (reading approved
 * entries). Leave them empty and the site runs read-only from data/entries.json.
 * Never put the service-role key, the Resend key or admin emails in this file. */
window.ENT_CONFIG = {
  supabaseUrl: "",      // e.g. "https://abcdefghijklmnop.supabase.co"
  supabaseAnonKey: ""   // Project Settings -> API -> anon / publishable key
};
