# Meta App Review: reviewer steps

The sidebar matches these steps: Messaging → Inbox, Comments, Auto Replies, Channels.
Use this text in the next App Review submission.

## Test instructions

1. Open https://fullfilio.com/login and sign in with the test account given in the
   "App verification details" field.
2. In the left menu open **Messaging → Channels** (https://fullfilio.com/admin/inbox/channels).
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
6. Open **Messaging → Inbox** (https://fullfilio.com/admin/inbox). The messages appear within
   a few seconds (received through webhooks: pages_messaging, instagram_manage_messages).
   The customer's public name and profile picture are shown next to the conversation
   (public_profile).
7. Open **Messaging → Comments** (https://fullfilio.com/admin/inbox/comments). Comments are
   grouped under their post (pages_read_engagement, pages_read_user_content,
   instagram_manage_comments).
8. Type a reply in a chat and send it. The reply is delivered to the customer in
   Messenger / Instagram (pages_messaging, instagram_manage_messages). On the Comments
   page, reply to a comment in public, in private, or both (pages_manage_engagement,
   instagram_manage_comments).
9. To disconnect, go to **Messaging → Channels** and click **Disconnect**. The stored access
   token is deleted.

## Meta APIs used

Facebook Login for Business (redirect flow with our configuration ID); Graph API
/me/accounts, /{page-id}/subscribed_apps, Messenger Send API and Instagram Messaging API
(/{page-id}/messages), comment replies, and profile lookups for the customer's name and
picture. We do not request email, friends, birthday or other profile fields. Tokens are
stored encrypted.

Privacy: https://fullfilio.com/privacy · Data deletion: https://fullfilio.com/data-deletion

## Second request (November 2026)

The first review (submitted 18 Oct, answered 1 Nov 2026) approved pages_show_list,
pages_manage_metadata, pages_messaging and business_management. pages_read_engagement was
refused as "Screencast Not Aligned with Use Case Details": the use case is allowed, but the video
did not show the whole flow (Facebook login, the permission being allowed, the feature working).

Asked for this time, with a screencast uploaded for each:

| Permission | Used for |
|---|---|
| pages_read_engagement | The Page's own posts under Comments; the Page's linked Instagram account |
| pages_read_user_content | Customers' comments on the Page's posts |
| pages_manage_engagement | Reply in public, like, hide and delete Facebook comments |
| instagram_basic | The Instagram account's name and picture, and the posts comments belong to |
| instagram_manage_messages | Instagram Direct messages in the Inbox: read, reply, private reply to a comment |
| instagram_manage_comments | Instagram comments: read, reply in public, hide, delete |
| whatsapp_business_management | WhatsApp signup: the business's WhatsApp account and number, connect and register it |
| whatsapp_business_messaging | WhatsApp messages in the Inbox: receive and reply |
| Human Agent (feature) | A staff member's reply to a Messenger or Instagram chat after 24 hours (HUMAN_AGENT tag) |

Before recording:
1. Facebook Login for Business → Configurations → the configuration Fullfilio uses: tick all of the
   permissions above (and the approved ones), or the permission screen will not show them.
2. On the recording Facebook account: Settings → Business integrations → remove Fullfilio, so
   the full login and permission screens show again. Disconnect the Page in Messaging → Channels.
3. The Instagram account is a professional account linked to the Page, with Settings → Messages
   and story replies → Message controls → Connected tools → "Allow access to messages" on.
4. Facebook and Instagram in English. A second Facebook account and a second Instagram account
   to send the comments and messages.

Screencast (captions on every step):
1. fullfilio.com/login → sign in.
2. Messaging → Channels → Continue with Facebook.
3. Facebook: log in, choose the Page and the Instagram account, show the permission list, Allow.
4. Fullfilio: tick the Page and the Instagram account → Connect; both show as connected.
5. Facebook comments: comment from the second account; Messaging → Comments shows the post and
   comment; Reply in public, Like, Hide, each checked on Facebook.
6. Instagram comments: comment from the second Instagram account; Messaging → Comments shows it
   under the post; Reply in public and Hide, each checked in Instagram.
7. Instagram Direct: send a DM from the second account; Messaging → Inbox shows it with the
   sender's name and picture; reply; the reply arrives in Instagram. Then send a private reply to
   an Instagram comment and show it arriving as a DM.
8. WhatsApp: Messaging → Channels → connect WhatsApp; Meta's signup: log in, choose the business,
   the WhatsApp account and the number, verify it; the number shows as connected. Send a WhatsApp
   message from a phone; it appears in Messaging → Inbox; reply; the reply arrives on the phone.
9. Human Agent: a staff member answers a Messenger chat whose last customer message is older than
   24 hours (an older test chat), and the reply arrives in Messenger.
