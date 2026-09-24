SELECT cron.schedule(
  'lckdin-daily-reminder',
  '30 15 * * *',
  $$
  SELECT net.http_post(
    url := 'https://qtlhpaqsmbyneivdsiei.supabase.co/functions/v1/send-daily-reminder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF0bGhwYXFzbWJ5bmVpdmRzaWVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5OTAwNzIsImV4cCI6MjA5OTU2NjA3Mn0.aA_rt0M71EB6bsOwkO01bRt26wQcx73lAXRGvxOFpVo',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF0bGhwYXFzbWJ5bmVpdmRzaWVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5OTAwNzIsImV4cCI6MjA5OTU2NjA3Mn0.aA_rt0M71EB6bsOwkO01bRt26wQcx73lAXRGvxOFpVo'
    ),
    body := '{}'::jsonb
  );
  $$
);
