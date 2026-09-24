-- notify_waitlist_signup: only the trigger should invoke this, not public RPC
revoke execute on function public.notify_waitlist_signup() from anon, authenticated, public;

-- rls_auto_enable: pre-existing helper, not meant for public RPC either
revoke execute on function public.rls_auto_enable() from anon, authenticated, public;
