export function createClientId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
    /[xy]/g,
    (character) => {
      const randomNibble = Math.floor(Math.random() * 16);
      const value =
        character === "x" ? randomNibble : (randomNibble & 0x3) | 0x8;
      return value.toString(16);
    },
  );
}
