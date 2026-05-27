export type ShellConfirmationRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
};

export type ShellConfirmationResult = {
  confirmed: boolean;
  response: number;
};
