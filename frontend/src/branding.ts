// Product name shown in the UI and the browser tab. Override at build time with
// VITE_APP_NAME (e.g. in frontend/.env.production); defaults to upstream's name.
export const APP_NAME: string = import.meta.env.VITE_APP_NAME || "ExcaliDash";
