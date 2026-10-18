# Meta App Review: reviewer steps (Inbox menu names)

Use this text in the next App Review submission. The menu that used to be called
"Messaging" is now called "Inbox". The page links are unchanged.

## Test instructions

1. Open https://fullfilio.com/login and sign in with the test account given in the
   "App verification details" field.
2. In the left menu open **Inbox → Channels** (https://fullfilio.com/admin/inbox/channels).
3. Click **Continue with Facebook**. Log in with a Facebook test user who manages a Page
   (ideally with a linked Instagram professional account), choose the Page(s) and allow
   the permissions.
4. You return to https://fullfilio.com/admin/inbox/meta-callback. Fullfilio lists the
   allowed Pages (pages_show_list, business_management) and linked Instagram accounts
   (instagram_basic). Tick them and click **Connect**. Fullfilio subscribes the Page to
   our webhook (pages_manage_metadata), and the Page then shows as connected on the
   Channels page.
5. From a different Facebook/Instagram account, send a message to the Page on Messenger,
   send a Direct message to the Instagram account, and comment on a Page post.
6. Open **Inbox → Chats** (https://fullfilio.com/admin/inbox). The messages appear within
   a few seconds (received through webhooks: pages_messaging, instagram_manage_messages).
   The customer's public name and profile picture are shown next to the conversation
   (public_profile).
7. Open **Inbox → Comments** (https://fullfilio.com/admin/inbox/comments). Comments are
   grouped under their post (pages_read_engagement, pages_read_user_content,
   instagram_manage_comments).
8. Type a reply in a chat and send it. The reply is delivered to the customer in
   Messenger / Instagram (pages_messaging, instagram_manage_messages). On the Comments
   page, reply to a comment in public, in private, or both (pages_manage_engagement,
   instagram_manage_comments).
9. To disconnect, go to **Inbox → Channels** and click **Disconnect**. The stored access
   token is deleted.

## Meta APIs used

Facebook Login for Business (redirect flow with our configuration ID); Graph API
/me/accounts, /{page-id}/subscribed_apps, Messenger Send API and Instagram Messaging API
(/{page-id}/messages), comment replies, and profile lookups for the customer's name and
picture. We do not request email, friends, birthday or other profile fields. Tokens are
stored encrypted.

Privacy: https://fullfilio.com/privacy · Data deletion: https://fullfilio.com/data-deletion
