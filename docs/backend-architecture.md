# معماری Backend دادبان

## تصمیم این مرحله

برای نسخه اول Backend، Supabase + PostgreSQL + Supabase Auth + Edge Functions انتخاب شده است.

این معماری PostgreSQL واقعی، احراز هویت، Row Level Security و منطق سروری را در یک مسیر امن کنار هم قرار می‌دهد و بعداً برای اپ موبایل نیز قابل استفاده است.

## معماری

Browser / Mobile App
→ Supabase Auth
→ JWT
→ Edge Function
→ PostgreSQL
→ RLS

اطلاعات هویتی احراز هویت در auth.users است.
اطلاعات کاری کاربر در public.users است.
ارتباط این دو از طریق public.users.auth_user_id انجام می‌شود.

## جداسازی دفترها

هر کاربر معتبر یک office_id دارد.
تمام عملیات روی موکل‌ها باید در محدوده office_id کاربر اجرا شود.
کاربر دفتر A نباید بتواند موکل دفتر B را بخواند، ایجاد کند یا ویرایش کند.
DELETE فیزیکی برای کاربر عادی فعال نمی‌شود و حذف به صورت Soft Delete خواهد بود.

## Secretها

هیچ Secret، Service Key، Database Password یا Token داخل GitHub قرار نمی‌گیرد.
کلیدهای سطح بالا فقط در محیط سرور یا Supabase Secrets نگهداری می‌شوند.

## مرحله بعد

1. ساخت پروژه Supabase
2. اجرای database/schema.sql
3. اجرای supabase/migrations/0002_security_rls.sql
4. ساخت اولین Office
5. ساخت اولین حساب Auth
6. اتصال حساب Auth به public.users.auth_user_id
7. ساخت Edge Function برای Clients
8. اتصال فرم ثبت موکل
9. اتصال لیست موکل‌ها
10. اتصال ویرایش و Soft Delete
11. تست جداسازی دو دفتر
12. تست دسترسی بدون احراز هویت

## قانون

تا زمانی که Auth و RLS کامل تست نشده‌اند، اطلاعات واقعی موکلان وارد محیط تولید نمی‌شود.