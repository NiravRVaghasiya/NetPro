// Shared by the React card/preview and offline HTML. Scoped to avoid styling the app.
export const PROFILE_CARD_CSS = `
.np-card{box-sizing:border-box;width:100%;background:#fffefa;color:#183c30;border:1px solid #dce3dc;border-radius:24px;overflow:hidden;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 18px 55px -28px #183c3045;text-align:left;overflow-wrap:anywhere}
.np-card *{box-sizing:border-box}
.np-card-top{padding:28px 32px 0;display:flex;align-items:center;justify-content:space-between;gap:16px}
.np-card-kicker{font-size:10px;line-height:1.6;letter-spacing:.16em;font-weight:700;text-transform:uppercase;color:#567164;margin:0}
.np-card-mark{display:inline-flex;gap:5px;align-items:center;font-size:13px;font-weight:700;letter-spacing:-.02em}
.np-card-mark i{display:inline-block;width:7px;height:7px;border-radius:50%;background:#448368}
.np-card-main{padding:32px}
.np-card-avatar{display:flex;align-items:center;justify-content:center;width:72px;height:72px;border-radius:20px;background:#e8eee4;color:#24523e;font-size:25px;font-weight:500;letter-spacing:-.06em;margin-bottom:24px}
.np-card h1{font-size:clamp(28px,5vw,42px);letter-spacing:-.055em;font-weight:600;line-height:1.12;margin:0 0 12px}
.np-card-headline{font-size:17px;line-height:1.6;color:#526459;margin:0;white-space:pre-wrap}
.np-card-facts{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px;font-size:12px;line-height:1.5;color:#3d5c4b}
.np-card-facts span{background:#f0f3ec;border:1px solid #e3e9de;border-radius:6px;padding:6px 10px}
.np-card-bio{font-size:15px;line-height:1.8;color:#475b4f;margin:26px 0 0;white-space:pre-wrap}
.np-card-links{display:grid;gap:9px;margin-top:26px}
.np-card-links a{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:14px 16px;border:1px solid #dce3dc;border-radius:10px;color:#234333;text-decoration:none;font-size:14px;font-weight:500;transition:background .15s}
.np-card-links a:hover{background:#f0f3ec}
.np-card a:focus-visible{outline:3px solid #538463;outline-offset:4px}
.np-card-links b{font-size:18px;font-weight:400;color:#738577}
.np-card-footer{padding:24px 32px;background:#f4f6f0;border-top:1px solid #e2e8df}
.np-card-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
.np-card-actions a,.np-card-actions span{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 18px;border-radius:8px;font-size:13px;line-height:1.6;font-weight:600;text-decoration:none;background:#214e3b;color:#fffefa;border:1px solid #214e3b}
.np-card-actions .np-card-secondary{color:#234333;background:transparent;border-color:#cfd9ce}
.np-card-contact{display:flex;flex-direction:column;gap:4px;margin:16px 0 0;font-size:12px;line-height:1.7;color:#51685a}
.np-card-contact a{color:inherit;text-decoration:none}
.np-card-contact a:hover{text-decoration:underline}
@media(max-width:480px){.np-card-top{padding:22px 22px 0}.np-card-main{padding:26px 22px}.np-card-footer{padding:22px}.np-card-avatar{width:62px;height:62px}.np-card-actions a,.np-card-actions span{flex:1}}
`;
