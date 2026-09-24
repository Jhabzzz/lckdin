alter table public.profiles
  add column rules jsonb;

comment on column public.profiles.rules is 'User-customized daily rule list: array of {t: text, flag?: boolean}. Null/empty means use the app default list.';
