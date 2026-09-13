/** "₦50,000.00" — how an amount reads in a message to a parent. */
export function naira(value: number): string {
  return `₦${value.toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
