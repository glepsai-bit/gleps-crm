const backendModeError = () => {
  throw new Error('Supabase client is unavailable when VITE_USE_BACKEND=true');
};

const createThrowProxy = (): any =>
  new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        return createThrowProxy();
      },
      apply() {
        backendModeError();
      },
    }
  );

export const supabase: any = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'auth') {
        return {
          getSession: async () => ({ data: { session: null }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          signInWithPassword: async () => backendModeError(),
          signUp: async () => backendModeError(),
          signOut: async () => ({ error: null }),
        };
      }

      if (prop === 'channel') {
        return () => ({ on: () => ({ subscribe: () => ({ unsubscribe() {} }) }) });
      }

      if (prop === 'removeChannel') {
        return async () => undefined;
      }

      return createThrowProxy();
    },
  }
);