import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.spycakes.dokuscan',
  appName: 'Doku Scan',
  webDir: 'out',
  plugins: {
    SocialLogin: {
      // Only Google sign-in (Drive backup) is used. Leaving the others out keeps the
      // Facebook SDK, with its advertising-ID and install-referrer permissions, out of the app.
      providers: { google: true, facebook: false, apple: false, twitter: false },
    },
  },
};

export default config;
