import { useLayoutEffect, useState } from 'react';

const THEME_STORAGE_KEY = 'ticketing-theme';

function getSavedTheme() {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark';
  } catch (error) {
    console.error('Unable to read saved theme preference.', error);
    return false;
  }
}

function useTheme() {
  const [darkTheme, setDarkTheme] = useState(getSavedTheme);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = darkTheme ? 'dark' : 'light';
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, darkTheme ? 'dark' : 'light');
    } catch (error) {
      console.error('Unable to save theme preference.', error);
    }
  }, [darkTheme]);

  return { darkTheme, toggleTheme: () => setDarkTheme((isDark) => !isDark) };
}

export default useTheme;
