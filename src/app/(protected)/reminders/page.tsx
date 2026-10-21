import { redirect } from 'next/navigation';

// Reminders live on My Tasks. This address stays because due-reminder bells
// and older links point here.
export default function RemindersPage() {
  redirect('/my-tasks#reminders');
}
