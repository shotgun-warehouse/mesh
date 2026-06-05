export type ChatMessage = {
  id: string;
  text: string;
  timestamp: number;
  outgoing: boolean;
  senderId: string;
  displayName?: string;
};

export type ChatWireMessage = {
  type: "chat";
  text: string;
};
