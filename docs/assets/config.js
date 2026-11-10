/* Site configuration. Both values are public by design: the anon key only
 * grants what the database's row-level security allows (reading approved
 * entries). Leave them empty and the site shows only a "not open yet" notice.
 * Never put the service-role key, the Resend key or admin emails in this file. */
window.ENT_CONFIG = {
  supabaseUrl: "https://kdwczksvcptcbaivwadk.supabase.co",
  supabaseAnonKey: "sb_publishable_YoJ-bzryOFPCfM27_dwXsg_ATHsT5qT"   // publishable key: safe to expose
};
