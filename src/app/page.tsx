import { redirect } from "next/navigation";

export default function HomePage(): never {
  redirect("/approvals"); // the approvals page requires sign-in and sends people to /login when needed
}
